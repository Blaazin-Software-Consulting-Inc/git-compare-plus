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
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AheadBehind, AheadBehindPort } from '../aheadBehind';
import type { ComparisonPort } from '../comparison';
import { DEFAULT_BRANCH_SETTINGS, fallbackCandidates, overrideFor, type DefaultBranchSettings } from '../defaultBranch';
import type { Logger } from '../logger';
import {
  COMMIT_LOG_FORMAT,
  REF_LIST_FORMAT,
  TAG_LIST_FORMAT,
  countStatusEntries,
  lineStatsOfContent,
  parseAheadBehindRefs,
  parseBlameIncremental,
  parseCommitLog,
  parseCommitDates,
  parseNameStatusZ,
  parseNulList,
  parseLeftRightCount,
  parseLsTreeZ,
  parseNumstatZ,
  parseRefList,
  parseTagList,
  parseWorktreeList,
  type BlameLine,
  type ChangedFile,
  type CommitEntry,
  type LineStats,
  type RefEntry,
  type TagEntry,
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
// Untracked files above this size get no line count: reading a multi-MB generated file or dump to
// show "+40000" is not worth the extension-host memory, and the file is still listed.
const MAX_UNTRACKED_STATS_BYTES = 2 * 1024 * 1024;
// Files read at once (line stats, content hashes); bounded so a worktree with thousands of new
// files cannot hit EMFILE.
const FILE_READ_CONCURRENCY = 16;
// Paths per `git ls-tree` call: keeps the argument list well under the OS limit (~256 KB on macOS,
// 32 KB on Windows) for deep paths.
const LS_TREE_PATHS_PER_CALL = 200;

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
export class GitCli implements ComparisonPort, AheadBehindPort {
  /**
   * @param gitPath - git binary; the built-in git extension's resolved path so both agree.
   * @param logger - receives DEBUG lines per command (args, duration).
   * @param defaultBranchSettings - reads `branchCompare.remote` / `branchCompare.defaultBranches`
   *   on each call, so a settings change applies on the next refresh without a restart.
   */
  constructor(
    private readonly gitPath: string,
    private readonly logger: Logger,
    private readonly defaultBranchSettings: () => DefaultBranchSettings = () => DEFAULT_BRANCH_SETTINGS,
  ) {}

  /** Worktrees of the repository containing `cwd`; the first entry is the main worktree. */
  async worktrees(cwd: string): Promise<WorktreeEntry[]> {
    return parseWorktreeList(await this.run(cwd, ['worktree', 'list', '--porcelain']));
  }

  /**
   * Committer dates (ms since epoch) of the given full SHAs, in one git call. Used to order
   * worktrees by their latest commit. Unknown SHAs make git fail; callers pass worktree HEADs only.
   */
  async commitDates(cwd: string, shas: readonly string[]): Promise<Map<string, number>> {
    if (shas.length === 0) {
      return new Map();
    }
    return parseCommitDates(await this.run(cwd, ['show', '-s', '--format=%H %ct', ...shas]));
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
   * The repo's default branch (see src/defaultBranch.ts): a per-repo override when one is set and
   * exists; otherwise `<remote>/HEAD` (normal for clones); otherwise the first existing of
   * `<remote>/main`, `<remote>/master`, `main`, `master`. `<remote>` is `origin` unless the
   * `branchCompare.remote` setting says otherwise.
   * @returns a ref name, or `undefined` when none of those exist.
   */
  async defaultBranch(cwd: string): Promise<string | undefined> {
    const settings = this.defaultBranchSettings();
    const override = await this.configuredOverride(cwd, settings);
    if (override !== undefined) {
      return override;
    }
    try {
      const ref = (await this.run(cwd, ['symbolic-ref', '--short', `refs/remotes/${settings.remote}/HEAD`])).trim();
      if (ref.length > 0) {
        return ref;
      }
    } catch (error) {
      // Expected when the remote was added after cloning or `<remote>/HEAD` was never fetched;
      // the fallback below covers it. `git remote set-head <remote> --auto` fixes it permanently.
      this.logger.debug('remote HEAD not set', { function: 'defaultBranch', cwd, remote: settings.remote, reason: errorMessage(error) });
    }
    const names = new Set((await this.refs(cwd)).map((r) => r.name));
    const fallback = fallbackCandidates(settings.remote).find((n) => names.has(n));
    this.logger.warn('default branch resolved by fallback', { function: 'defaultBranch', cwd, remote: settings.remote, fallback });
    return fallback;
  }

  // Overrides are keyed by the main worktree, so a linked worktree's cwd is mapped to it first.
  // Skipped entirely (no git call) when no overrides are configured, which is the common case.
  private async configuredOverride(cwd: string, settings: DefaultBranchSettings): Promise<string | undefined> {
    if (Object.keys(settings.overrides).length === 0) {
      return undefined;
    }
    const mainWorktree = (await this.worktrees(cwd))[0]?.path;
    const override = mainWorktree === undefined ? undefined : overrideFor(settings, mainWorktree);
    if (override === undefined) {
      return undefined;
    }
    if ((await this.resolveCommit(cwd, override)) === undefined) {
      // A typo in the setting must not silently compare against the wrong branch: say so, then
      // fall back to the automatic choice so the views still work.
      this.logger.warn('default-branch override does not exist; using the automatic default', {
        function: 'defaultBranch',
        cwd,
        mainWorktree,
        override,
      });
      return undefined;
    }
    return override;
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
   * Lines added/removed per file for the same diff as `diffNameStatus` (same arguments, same `-M`),
   * keyed by the subject-side path. Separate call because `--numstat` and `--name-status` cannot be
   * combined into one parseable output.
   */
  async diffNumstat(cwd: string, from: string, to?: string): Promise<Map<string, LineStats>> {
    const revisions = to === undefined ? [from] : [from, to];
    return parseNumstatZ(await this.run(cwd, ['diff', '--numstat', '-z', '-M', ...revisions, '--']));
  }

  /**
   * Line counts for untracked files (git has no diff for them), read from disk. Files that are
   * too large or unreadable (deleted since listing) are left out of the map rather than failing.
   * @param root - worktree root the paths are relative to.
   * @param relativePaths - repo-relative POSIX paths, as from `untracked`.
   */
  async untrackedLineStats(root: string, relativePaths: readonly string[]): Promise<Map<string, LineStats>> {
    return mapFilesInBatches(relativePaths, (relativePath) => this.readUntrackedStats(path.join(root, relativePath)));
  }

  /**
   * Object IDs of `paths` in a commit or tree (`git ls-tree -r -z`), keyed by path. Paths that do
   * not exist at `revision` are absent from the map. Pathspecs are literal (`GIT_LITERAL_PATHSPECS`),
   * so a file named `*.ts` cannot match other files.
   * @param cwd - worktree root; paths are repo-relative, as git diff prints them.
   */
  async blobIds(cwd: string, revision: string, paths: readonly string[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (let start = 0; start < paths.length; start += LS_TREE_PATHS_PER_CALL) {
      const chunk = paths.slice(start, start + LS_TREE_PATHS_PER_CALL);
      const output = await this.run(cwd, ['ls-tree', '-r', '-z', revision, '--', ...chunk], { env: { GIT_LITERAL_PATHSPECS: '1' } });
      for (const [filePath, id] of parseLsTreeZ(output)) {
        ids.set(filePath, id);
      }
    }
    return ids;
  }

  /**
   * Git blob IDs of files on disk, computed the way `git hash-object` does without filters
   * (SHA-1 of `blob <size>\0<content>`; a symlink hashes its target path). Equal to the committed
   * blob ID for a file committed unchanged in a SHA-1 repo without clean filters (e.g. autocrlf).
   * Paths that cannot be hashed (deleted since listing, directories such as submodules) are absent.
   */
  async hashWorkingFiles(root: string, relativePaths: readonly string[]): Promise<Map<string, string>> {
    return mapFilesInBatches(relativePaths, (relativePath) => this.hashWorkingFile(path.join(root, relativePath)));
  }

  private async hashWorkingFile(absolutePath: string): Promise<string | undefined> {
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        return gitBlobId(Buffer.from(await readlink(absolutePath)));
      }
      if (!info.isFile()) {
        return undefined;
      }
      // Streamed: changed files include lockfiles and generated bundles; no need to hold them in memory.
      const hash = createHash('sha1').update(`blob ${info.size}\0`);
      for await (const chunk of createReadStream(absolutePath)) {
        hash.update(chunk as Buffer);
      }
      return hash.digest('hex');
    } catch (error) {
      // Expected race: deleted or replaced between the diff and this read. The file simply has no
      // fingerprint this time, so it shows as not reviewed until the next refresh.
      this.logger.debug('working file unreadable for content hash', { function: 'hashWorkingFile', absolutePath, reason: errorMessage(error) });
      return undefined;
    }
  }

  private async readUntrackedStats(absolutePath: string): Promise<LineStats | undefined> {
    try {
      if ((await stat(absolutePath)).size > MAX_UNTRACKED_STATS_BYTES) {
        return undefined;
      }
      return lineStatsOfContent(await readFile(absolutePath));
    } catch (error) {
      // Expected race: the file was deleted or renamed between `ls-files` and this read. The file
      // is still listed (the next refresh drops it); it just has no line count this time.
      this.logger.debug('untracked file unreadable for line stats', { function: 'readUntrackedStats', absolutePath, reason: errorMessage(error) });
      return undefined;
    }
  }

  /**
   * The worktree root containing `directory` (`rev-parse --show-toplevel`), or undefined when it
   * is not inside a git worktree.
   */
  async toplevel(directory: string): Promise<string | undefined> {
    try {
      return (await this.run(directory, ['rev-parse', '--show-toplevel'])).trim();
    } catch (error) {
      if (error instanceof GitCommandError) {
        // Expected for files outside any repository (exit 128); also covers a deleted folder.
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Blame `relativePath` as it is in the editor (`--contents -`, the text passed on stdin), so
   * unsaved edits show as uncommitted lines rather than shifting every line below them.
   * @param root - worktree root (from `toplevel`).
   * @returns one entry per line; undefined when git cannot blame the file (untracked, outside HEAD).
   */
  async blame(root: string, relativePath: string, contents: string): Promise<BlameLine[] | undefined> {
    try {
      return parseBlameIncremental(await this.run(root, ['blame', '--incremental', '--contents', '-', '--', relativePath], { input: contents }));
    } catch (error) {
      if (error instanceof GitCommandError && error.details.exitCode === 128) {
        // Expected: a new file not in HEAD yet ("no such path"), or a file git ignores.
        return undefined;
      }
      throw error;
    }
  }

  /** One commit's metadata (`git log -1`), or undefined when `revision` is not a commit. */
  async commit(cwd: string, revision: string): Promise<CommitEntry | undefined> {
    try {
      return parseCommitLog(await this.run(cwd, ['log', '-1', '-z', `--format=${COMMIT_LOG_FORMAT}`, revision, '--']))[0];
    } catch (error) {
      if (error instanceof GitCommandError && error.details.exitCode === 128) {
        return undefined;
      }
      throw error;
    }
  }

  /** A commit's full message (`git show -s --format=%B`), for the blame hover. */
  async commitMessage(cwd: string, sha: string): Promise<string> {
    return this.run(cwd, ['show', '-s', '--format=%B', sha]);
  }

  /** Tags, newest first (by tag or commit date). */
  async tags(cwd: string): Promise<TagEntry[]> {
    return parseTagList(await this.run(cwd, ['for-each-ref', '--sort=-creatordate', `--format=${TAG_LIST_FORMAT}`, 'refs/tags']));
  }

  /**
   * The newest `limit` commits on any branch or tag (`git log --all`), for picking a commit as a
   * comparison side. Newest first by commit date.
   */
  async recentCommits(cwd: string, limit: number): Promise<CommitEntry[]> {
    return parseCommitLog(await this.run(cwd, ['log', '--all', '-z', `--format=${COMMIT_LOG_FORMAT}`, `--max-count=${limit}`, '--']));
  }

  /**
   * Commits reachable from `to` but not from `from` (`git log from..to`), newest first, at most
   * `limit`. `to` may be `HEAD`, resolved in `cwd` (a worktree's own checkout).
   */
  async commitsBetween(cwd: string, from: string, to: string, limit: number): Promise<CommitEntry[]> {
    return parseCommitLog(await this.run(cwd, ['log', '-z', `--format=${COMMIT_LOG_FORMAT}`, `--max-count=${limit}`, `${from}..${to}`, '--']));
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

  /**
   * Ahead/behind of every local and remote branch against `baseSha`, in one history walk
   * (`%(ahead-behind:…)`, git 2.41+). Keyed by short ref name.
   * @returns undefined when this git does not know the atom (it rejects the format with exit 128);
   *   the caller then counts per branch. Other failures throw.
   */
  async aheadBehindAllRefs(cwd: string, baseSha: string): Promise<Map<string, AheadBehind> | undefined> {
    try {
      return parseAheadBehindRefs(
        await this.run(cwd, ['for-each-ref', `--format=%(refname)%00%(refname:short)%00%(ahead-behind:${baseSha})`, 'refs/heads', 'refs/remotes']),
      );
    } catch (error) {
      if (error instanceof GitCommandError && /unknown field name|ahead-behind/i.test(error.details.stderr)) {
        return undefined;
      }
      throw error;
    }
  }

  /** Ahead/behind of one revision against `baseSha` (`rev-list --left-right --count base...rev`). */
  async aheadBehind(cwd: string, baseSha: string, revision: string): Promise<AheadBehind> {
    const counts = parseLeftRightCount(await this.run(cwd, ['rev-list', '--left-right', '--count', `${baseSha}...${revision}`, '--']));
    if (counts === undefined) {
      throw new Error(`unexpected rev-list --count output for ${revision}`);
    }
    return counts;
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
    options: { readonly env?: Readonly<Record<string, string>>; readonly timeoutMs?: number; readonly input?: string } = {},
  ): Promise<string> {
    const startedAt = Date.now();
    try {
      const running = execFileAsync(this.gitPath, [...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...options.env },
      });
      // Text for commands that read stdin (`blame --contents -`); others get an empty, closed stdin.
      running.child.stdin?.end(options.input ?? '');
      const { stdout } = await running;
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
 * Run `read` for each path, at most FILE_READ_CONCURRENCY at a time, and collect the defined
 * results by path. `read` must not reject; it returns `undefined` for a file it cannot handle.
 */
async function mapFilesInBatches<T>(paths: readonly string[], read: (relativePath: string) => Promise<T | undefined>): Promise<Map<string, T>> {
  const results = new Map<string, T>();
  for (let start = 0; start < paths.length; start += FILE_READ_CONCURRENCY) {
    const batch = paths.slice(start, start + FILE_READ_CONCURRENCY);
    await Promise.all(
      batch.map(async (relativePath) => {
        const value = await read(relativePath);
        if (value !== undefined) {
          results.set(relativePath, value);
        }
      }),
    );
  }
  return results;
}

/** `git hash-object` for an in-memory buffer (SHA-1 object format). */
function gitBlobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
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
