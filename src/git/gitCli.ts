/**
 * GitCli — runs git as a child process for everything the views and comparisons need.
 *
 * Why the CLI instead of the built-in git extension's API: that API only knows repositories open in
 * the window. Linked worktrees (e.g. `.claude/worktrees/*`) usually are not, and its `toGitUri`
 * content provider cannot read files for a repo it has not opened. Plain git sees every worktree
 * and reads any `<rev>:<path>` from the shared object store. The built-in API is still used, but
 * only to discover repos and to find the git binary (repoDiscovery.ts).
 *
 * Every command runs with:
 *   - `GIT_OPTIONAL_LOCKS=0`: `git diff` would otherwise refresh the index and take `index.lock`,
 *     racing the editor's own background `git status` and producing spurious "lock exists" failures.
 *   - `LC_ALL=C`: stable, untranslated output for the parsers.
 *
 * Error handling: a failed command throws `GitCommandError` carrying args, cwd, exit code and stderr,
 * so the caller (which knows whether the failure is expected, e.g. an unknown ref) can log it at the
 * right level with that context. `run` itself logs failures at DEBUG only.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { ComparisonPort } from '../comparison';
import type { Logger } from '../logger';
import {
  REF_LIST_FORMAT,
  countStatusEntries,
  parseNameStatusZ,
  parseNulList,
  parseRefList,
  parseWorktreeList,
  type ChangedFile,
  type RefEntry,
  type WorktreeEntry,
} from './parsers';

const execFileAsync = promisify(execFile);

// File contents for the diff editor can be large (lockfiles, generated code). 64 MB keeps a
// pathological file from crashing the extension host while covering anything reviewable.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
// Fetching 10+ remotes over a VPN can legitimately take a while; still bounded so a hung
// connection cannot leave the progress spinner up forever.
const FETCH_TIMEOUT_MS = 120_000;

/** A git command exited non-zero or could not be started. */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly details: { readonly args: readonly string[]; readonly cwd: string; readonly exitCode?: number | string; readonly stderr: string },
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/** Git operations used by the extension. One instance per window, bound to one git binary. */
export class GitCli implements ComparisonPort {
  /**
   * @param gitPath - git binary; the built-in git extension's resolved path so both agree.
   * @param logger - receives DEBUG lines per command (args, duration).
   */
  constructor(
    private readonly gitPath: string,
    private readonly logger: Logger,
  ) {}

  /** Worktrees of the repository containing `cwd`; the first entry is the main worktree. */
  async worktrees(cwd: string): Promise<WorktreeEntry[]> {
    return parseWorktreeList(await this.run(cwd, ['worktree', 'list', '--porcelain']));
  }

  /** Local and remote-tracking branches, as ordered by git (alphabetical). */
  async refs(cwd: string): Promise<RefEntry[]> {
    return parseRefList(await this.run(cwd, ['for-each-ref', `--format=${REF_LIST_FORMAT}`, 'refs/heads', 'refs/remotes']));
  }

  /** Absolute path of the shared `.git` directory. Equal for a repo and all of its worktrees. */
  async commonDir(cwd: string): Promise<string> {
    return (await this.run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  }

  /**
   * The repo's default branch: `origin/HEAD` when set (normal for clones), otherwise the first of
   * `origin/main`, `origin/master`, `main`, `master` that exists.
   * @returns a ref name, or `undefined` when none of those exist.
   */
  async defaultBranch(cwd: string): Promise<string | undefined> {
    try {
      const ref = (await this.run(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
      if (ref.length > 0) {
        return ref;
      }
    } catch (error) {
      // Expected when the remote was added after cloning or `origin/HEAD` was never fetched;
      // the fallback below covers it. `git remote set-head origin --auto` fixes it permanently.
      this.logger.debug('origin/HEAD not set', { function: 'defaultBranch', cwd, reason: errorMessage(error) });
    }
    const names = new Set((await this.refs(cwd)).map((r) => r.name));
    const fallback = ['origin/main', 'origin/master', 'main', 'master'].find((n) => names.has(n));
    this.logger.warn('default branch resolved by fallback', { function: 'defaultBranch', cwd, fallback });
    return fallback;
  }

  /**
   * `git merge-base a b`.
   * @returns the commit SHA, or `undefined` when either ref does not exist (exit 128) or the
   *   histories are unrelated (exit 1). Other failures throw.
   */
  async mergeBase(cwd: string, refA: string, refB: string): Promise<string | undefined> {
    try {
      return (await this.run(cwd, ['merge-base', refA, refB])).trim();
    } catch (error) {
      if (error instanceof GitCommandError && (error.details.exitCode === 1 || error.details.exitCode === 128)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Files changed between `from` and `to`, or between `from` and the WORKING TREE of `cwd` when
   * `to` is omitted (staged and unstaged edits included). Rename detection is on (`-M`).
   */
  async diffNameStatus(cwd: string, from: string, to?: string): Promise<ChangedFile[]> {
    const revisions = to === undefined ? [from] : [from, to];
    return parseNameStatusZ(await this.run(cwd, ['diff', '--name-status', '-z', '-M', ...revisions, '--']));
  }

  /**
   * Resolve a revision to a full commit SHA (`rev-parse --verify <rev>^{commit}`).
   * @returns `undefined` when the revision does not exist or is not a commit.
   */
  async resolveCommit(cwd: string, revision: string): Promise<string | undefined> {
    try {
      return (await this.run(cwd, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])).trim();
    } catch (error) {
      if (error instanceof GitCommandError && (error.details.exitCode === 1 || error.details.exitCode === 128)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Number of uncommitted paths in the worktree at `root` (staged, unstaged, and untracked when
   * `includeUntracked`). Used to tell the user what a "committed only" comparison leaves out.
   */
  async uncommittedCount(root: string, includeUntracked: boolean): Promise<number> {
    const untrackedMode = includeUntracked ? 'normal' : 'no';
    return countStatusEntries(await this.run(root, ['status', '--porcelain=v1', '-z', `--untracked-files=${untrackedMode}`]));
  }

  /**
   * Capture the worktree at `root` exactly as it is on disk (committed + staged + unstaged, plus
   * untracked non-ignored files when `includeUntracked`) as a git TREE object, without touching
   * that worktree's files or its real index.
   *
   * How: copy the worktree's index to a temp file (the copy keeps git's stat cache, so only changed
   * files are re-hashed), point `GIT_INDEX_FILE` at it, `git add -A` / `-u`, then `git write-tree`.
   *
   * Side effect: blobs for edited files are written to the shared object store as unreferenced
   * objects; `git gc` prunes them after the usual grace period (2 weeks by default).
   *
   * @returns the tree SHA; readable with `git show <tree>:<path>` from any worktree of the repo.
   */
  async snapshotWorktree(root: string, includeUntracked: boolean): Promise<string> {
    const realIndex = (await this.run(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
    const tempDir = await mkdtemp(path.join(tmpdir(), 'branch-compare-index-'));
    const tempIndex = path.join(tempDir, 'index');
    const env = { env: { GIT_INDEX_FILE: tempIndex } };
    try {
      try {
        await copyFile(realIndex, tempIndex);
      } catch (error) {
        // No index yet (fresh worktree, nothing ever staged): start from HEAD instead. Slower,
        // because without a stat cache every file is hashed, but correct.
        this.logger.debug('index copy unavailable; seeding from HEAD', { function: 'snapshotWorktree', root, realIndex, reason: errorMessage(error) });
        await this.run(root, ['read-tree', 'HEAD'], env);
      }
      await this.run(root, ['add', includeUntracked ? '-A' : '-u'], env);
      const tree = (await this.run(root, ['write-tree'], env)).trim();
      this.logger.debug('worktree snapshot written', { function: 'snapshotWorktree', root, includeUntracked, tree });
      return tree;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * `git fetch --all --prune` — network call to every remote of the repo at `root`.
   *
   * Credentials: runs non-interactively (`GIT_TERMINAL_PROMPT=0`), so it relies on the user's
   * credential helper (macOS keychain). If no stored credential exists it fails fast with an
   * authentication error instead of hanging on an invisible prompt.
   * Logged at INFO per call (external request policy): durationMs, outcome, redacted stderr.
   */
  async fetch(root: string): Promise<void> {
    const startedAt = Date.now();
    this.logger.info('external request', { function: 'fetch', integration: 'git-remote', operation: 'git fetch --all --prune', root, attempt: 1 });
    try {
      await this.run(root, ['fetch', '--all', '--prune'], { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: FETCH_TIMEOUT_MS });
      this.logger.info('external response', {
        function: 'fetch',
        integration: 'git-remote',
        operation: 'git fetch --all --prune',
        root,
        durationMs: Date.now() - startedAt,
        outcome: 'success',
      });
    } catch (error) {
      this.logger.error('external request failed', error, {
        function: 'fetch',
        integration: 'git-remote',
        operation: 'git fetch --all --prune',
        root,
        durationMs: Date.now() - startedAt,
        outcome: error instanceof GitCommandError && error.details.exitCode === 'ETIMEDOUT' ? 'timeout' : 'server_error',
      });
      throw error;
    }
  }

  /** When the repo was last fetched (mtime of FETCH_HEAD, ms since epoch), or `undefined` if never. */
  async lastFetchedAt(root: string): Promise<number | undefined> {
    const fetchHead = (await this.run(root, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])).trim();
    try {
      return (await stat(fetchHead)).mtimeMs;
    } catch (error) {
      // No FETCH_HEAD: the repo has never been fetched since it was cloned.
      this.logger.debug('FETCH_HEAD missing', { function: 'lastFetchedAt', root, fetchHead, reason: errorMessage(error) });
      return undefined;
    }
  }

  /** `git check-ref-format --branch`: true when `name` is a valid new branch name. */
  async isValidBranchName(cwd: string, name: string): Promise<boolean> {
    try {
      await this.run(cwd, ['check-ref-format', '--branch', name]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError) {
        return false;
      }
      throw error;
    }
  }

  /** Create a branch at `startPoint` without switching to it. */
  async createBranch(cwd: string, name: string, startPoint: string): Promise<void> {
    await this.run(cwd, ['branch', '--', name, startPoint]);
  }

  /**
   * Delete a local branch with `-D`. Callers MUST have checked (see operations.ts) that it is not
   * checked out and confirmed with the user any commits that are not merged into the default
   * branch; `-d`'s own merged check compares with HEAD/upstream, not the default branch, so it
   * refuses or allows in cases that do not match what the user was told.
   */
  async deleteBranch(cwd: string, name: string): Promise<void> {
    await this.run(cwd, ['branch', '-D', '--', name]);
  }

  /** Number of commits on `branch` that are not on `base` (`rev-list --count base..branch`). */
  async commitsNotIn(cwd: string, branch: string, base: string): Promise<number> {
    return Number.parseInt((await this.run(cwd, ['rev-list', '--count', `${base}..${branch}`])).trim(), 10);
  }

  /**
   * Add a worktree at `worktreePath`.
   * - `{ kind: 'existing', branch }` checks out an existing local branch.
   * - `{ kind: 'track', newBranch, remoteRef }` creates `newBranch` tracking `remoteRef` and checks it out.
   */
  async addWorktree(
    cwd: string,
    worktreePath: string,
    checkout: { readonly kind: 'existing'; readonly branch: string } | { readonly kind: 'track'; readonly newBranch: string; readonly remoteRef: string },
  ): Promise<void> {
    const args =
      checkout.kind === 'existing'
        ? ['worktree', 'add', '--', worktreePath, checkout.branch]
        : ['worktree', 'add', '--track', '-b', checkout.newBranch, '--', worktreePath, checkout.remoteRef];
    await this.run(cwd, args);
  }

  /**
   * Remove a linked worktree. Without `force`, git refuses when the worktree has uncommitted or
   * untracked files — callers count those first and only pass `force` after explicit confirmation.
   */
  async removeWorktree(cwd: string, worktreePath: string, force: boolean): Promise<void> {
    await this.run(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', worktreePath]);
  }

  /**
   * Switch the worktree at `root` to a branch: an existing local branch, or a new local branch
   * tracking a remote one (`{ track: 'origin/x', newBranch: 'x' }`).
   */
  async switchBranch(root: string, target: { readonly branch: string } | { readonly newBranch: string; readonly track: string }): Promise<void> {
    // No `--` separator: `git switch` treats arguments after it as pathspecs it does not accept.
    // Safe because names come from existing refs or passed `check-ref-format --branch`, which
    // rejects a leading `-`.
    const args = 'branch' in target ? ['switch', target.branch] : ['switch', '--track', '-c', target.newBranch, target.track];
    await this.run(root, args);
  }

  /** Untracked, non-ignored files in the worktree at `cwd`, repo-relative. */
  async untracked(cwd: string): Promise<string[]> {
    return parseNulList(await this.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
  }

  /** File content at a revision (`git show <rev>:<path>`), decoded as UTF-8. */
  async show(cwd: string, revision: string, filePath: string): Promise<string> {
    return this.run(cwd, ['show', `${revision}:${filePath}`]);
  }

  private async run(
    cwd: string,
    args: readonly string[],
    options: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number } = {},
  ): Promise<string> {
    const startedAt = Date.now();
    try {
      const { stdout } = await execFileAsync(this.gitPath, [...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...options.env },
      });
      this.logger.debug('git command completed', { function: 'run', cwd, args, durationMs: Date.now() - startedAt });
      return stdout;
    } catch (error) {
      const failure = readExecFailure(error);
      // DEBUG only: many failures are expected probes (unknown ref, unset origin/HEAD). The caller
      // decides severity; the thrown error carries the full context for its log line.
      this.logger.debug('git command failed', { function: 'run', cwd, args, durationMs: Date.now() - startedAt, ...failure });
      throw new GitCommandError(`git ${args[0]} failed: ${summarizeStderr(failure.stderr) || errorMessage(error)}`, {
        args,
        cwd,
        ...failure,
      });
    }
  }
}

// execFile rejects with an Error augmented by `code` (exit code or errno string) and `stderr`;
// Node's typings do not declare them, so read them through a guard.
function readExecFailure(error: unknown): { exitCode?: number | string; stderr: string } {
  if (typeof error !== 'object' || error === null) {
    return { stderr: '' };
  }
  const code = 'code' in error && (typeof error.code === 'number' || typeof error.code === 'string') ? error.code : undefined;
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? redactUrlCredentials(error.stderr.slice(0, 2000)) : '';
  return { exitCode: code, stderr };
}

/**
 * Strip `user:password@` from URLs. git echoes remote URLs in errors, and a remote configured with
 * an embedded token (`https://user:token@host/...`) would otherwise land in logs and toasts.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(/(\w+:\/\/)[^/\s@]+:[^/\s@]+@/g, '$1<redacted>@');
}

/**
 * The line of stderr worth showing a user: git prints progress ("From …", "Preparing worktree…")
 * before the actual `fatal:` / `error:` line, so prefer that; fall back to the first line.
 */
export function summarizeStderr(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
