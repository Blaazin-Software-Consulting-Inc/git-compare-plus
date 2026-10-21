/**
 * comparison — computes what a SUBJECT (worktree or branch) changes relative to a BASE.
 *
 * Subject (the right-hand side, what is being reviewed):
 *   - worktree, `includeUncommitted: true`  → the files on disk: commits + staged + unstaged
 *     edits (+ untracked files when enabled).
 *   - worktree, `includeUncommitted: false` → the worktree's HEAD commit only. The number of
 *     uncommitted files left out is reported (`excludedUncommitted.subject`) so the UI can say so.
 *   - branch → the branch tip (committed by definition).
 *
 * Base (the left-hand side, what it is compared with):
 *   - `default` → each repo's own default branch (this workspace mixes `master` and `main`).
 *   - `ref`     → any branch, tag or SHA.
 *   - `worktree` → another worktree of the same repo: its HEAD commit, or, with
 *     `includeUncommitted`, a snapshot of its files on disk (a git tree built from a temp index;
 *     see GitCli.snapshotWorktree).
 *
 * Mode:
 *   - `merge-base` (default, PR-style): left side = merge-base(base, subject). Commits that landed
 *     on the base after the subject branched off do not show up as reverse changes.
 *   - `direct`: left side = the base itself; shows every difference between the two.
 *   A base that includes uncommitted edits is a tree, not a commit, so it has no merge base; the
 *   effective mode is then forced to `direct` and reported on the result.
 *
 * Line stats: each file carries `lines` (+/−) from `git diff --numstat` of the same two sides, or
 * from the file's bytes for untracked files. Best-effort: if they cannot be computed the files are
 * still listed, without counts (logged at WARN), because the file list is what the review needs.
 *
 * Fingerprints: each file also carries `fingerprint` (review/fingerprints.ts), the identity of its
 * diff that "reviewed" marks are stored against. Best-effort in the same way as line stats.
 *
 * Commits: `commits` lists the commits the comparison covers, `<left>..<subject>` (newest first,
 * capped at COMMIT_LIMIT): since the branch point in `merge-base` mode, or the subject's commits
 * the base lacks in `direct` mode. Uncommitted edits are not commits and never appear. Absent when
 * the base is a snapshot (a tree has no history) or when git failed (WARN; best-effort).
 *
 * Purity: no `vscode` import. Git is reached through `ComparisonPort` (implemented by GitCli), so
 * this module is unit-tested with a fake port.
 *
 * See also: src/git/gitCli.ts, src/views/changesHeader.ts (how these choices are shown).
 */
import * as path from 'node:path';
import type { ChangedFile, CommitEntry, LineStats } from './git/parsers';
import type { Logger } from './logger';
import { attachFingerprints, type FingerprintPort } from './review/fingerprints';

/** A git repository, identified by its main worktree. Linked worktrees belong to their repo. */
export interface RepoInfo {
  /** Display name: basename of `root`. */
  readonly name: string;
  /** Absolute path of the main worktree. */
  readonly root: string;
  /** Absolute path of the shared `.git` directory; identifies the repo across its worktrees. */
  readonly commonDir: string;
}

/** The side being reviewed. */
export type Subject =
  | { readonly kind: 'worktree'; readonly root: string; readonly label: string; readonly includeUncommitted: boolean }
  | { readonly kind: 'ref'; readonly ref: string; readonly label: string };

/** The side being compared against. Persisted per repo (baseStore.ts), so keep it JSON-serializable. */
export type BaseSpec =
  | { readonly kind: 'default' }
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'worktree'; readonly root: string; readonly label: string; readonly includeUncommitted: boolean };

/** How the left-hand side is chosen; see module doc. */
export type CompareMode = 'merge-base' | 'direct';

/** One repo + subject pair to compare. */
export interface ComparisonRequest {
  readonly repo: RepoInfo;
  readonly subject: Subject;
}

/**
 * Result for one request.
 * - `compared`    — `files` holds the changes (possibly none).
 * - `ref_missing` — the base (or the repo's default branch) does not exist, or shares no history.
 * - `failed`      — git errored; already logged at ERROR with context; `errorMessage` is for the UI.
 */
export interface ComparisonResult {
  readonly repo: RepoInfo;
  readonly subject: Subject;
  readonly outcome: 'compared' | 'ref_missing' | 'failed';
  /** The mode actually used; `direct` when the base includes uncommitted edits. */
  readonly mode: CompareMode;
  /** Human-readable base actually used, e.g. `origin/master` (resolved per repo for `default`). */
  readonly baseLabel?: string;
  /** Revision the LEFT side reads from: a merge-base commit, the base commit, or a snapshot tree. */
  readonly baseRevision?: string;
  /** Revision the RIGHT side reads from; absent when it is the working tree (files on disk). */
  readonly subjectRevision?: string;
  /** Uncommitted files that exist but are NOT part of this comparison, per side (undefined = n/a). */
  readonly excludedUncommitted: { readonly subject?: number; readonly base?: number };
  /** Sorted by path. */
  readonly files: readonly ChangedFile[];
  /** Commits the comparison covers; undefined when not applicable or unavailable (see module doc). */
  readonly commits?: CommitList;
  readonly errorMessage?: string;
}

/** Commits of one comparison, newest first. */
export interface CommitList {
  readonly entries: readonly CommitEntry[];
  /** More than COMMIT_LIMIT commits exist; only the newest COMMIT_LIMIT are listed. */
  readonly truncated: boolean;
}

/**
 * Commits listed per comparison. A review rarely spans more; a long-lived branch compared with an
 * old base could have thousands, and the list is redrawn on every automatic refresh.
 */
export const COMMIT_LIMIT = 200;

/** Git operations the comparison needs. Implemented by GitCli; faked in tests. */
export interface ComparisonPort extends FingerprintPort {
  defaultBranch(cwd: string): Promise<string | undefined>;
  mergeBase(cwd: string, refA: string, refB: string): Promise<string | undefined>;
  resolveCommit(cwd: string, revision: string): Promise<string | undefined>;
  diffNameStatus(cwd: string, from: string, to?: string): Promise<ChangedFile[]>;
  diffNumstat(cwd: string, from: string, to?: string): Promise<Map<string, LineStats>>;
  commitsBetween(cwd: string, from: string, to: string, limit: number): Promise<CommitEntry[]>;
  untrackedLineStats(root: string, relativePaths: readonly string[]): Promise<Map<string, LineStats>>;
  untracked(cwd: string): Promise<string[]>;
  uncommittedCount(root: string, includeUntracked: boolean): Promise<number>;
  snapshotWorktree(root: string, includeUntracked: boolean): Promise<string>;
}

/** Options shared by every comparison in one run. */
export interface ComparisonOptions {
  /** Treat untracked files as uncommitted edits (setting `branchCompare.includeUntracked`). */
  readonly includeUntracked: boolean;
  readonly logger: Logger;
}

/** True when the base side is a snapshot (tree), which forces `direct` mode. */
export function baseForcesDirect(base: BaseSpec): boolean {
  return base.kind === 'worktree' && base.includeUncommitted;
}

/**
 * Run several comparisons in parallel. Never rejects: each failure is isolated in its result so
 * one broken repo does not blank out the others.
 * @returns results in request order.
 */
export async function runComparisons(
  git: ComparisonPort,
  requests: readonly ComparisonRequest[],
  base: BaseSpec,
  mode: CompareMode,
  options: ComparisonOptions,
): Promise<ComparisonResult[]> {
  options.logger.info('comparison started', {
    function: 'runComparisons',
    base,
    mode,
    includeUntracked: options.includeUntracked,
    requests: requests.map((r) => ({ repo: r.repo.name, subject: r.subject })),
  });

  const results = await Promise.all(requests.map((request) => runComparison(git, request, base, mode, options)));

  options.logger.info('comparison finished', {
    function: 'runComparisons',
    base,
    results: results.map((r) => ({
      repo: r.repo.name,
      subject: r.subject.label,
      outcome: r.outcome,
      mode: r.mode,
      baseLabel: r.baseLabel,
      baseRevision: r.baseRevision,
      subjectRevision: r.subjectRevision,
      excludedUncommitted: r.excludedUncommitted,
      fileCount: r.files.length,
      lines: totalLineStats(r.files),
      commitCount: r.commits?.entries.length,
    })),
  });
  return results;
}

/** Working directory git must run in for a subject: the worktree itself, or the repo's main worktree. */
export function subjectCwd(request: ComparisonRequest): string {
  return request.subject.kind === 'worktree' ? request.subject.root : request.repo.root;
}

/** Base resolved to something git can diff against. Exactly one of `commitish` / `tree` is set. */
interface ResolvedBase {
  readonly label: string;
  /** A ref or SHA; merge-base applies. */
  readonly commitish?: string;
  /** A snapshot tree; merge-base does not apply. */
  readonly tree?: string;
  readonly excludedUncommitted?: number;
}

async function runComparison(
  git: ComparisonPort,
  request: ComparisonRequest,
  base: BaseSpec,
  requestedMode: CompareMode,
  options: ComparisonOptions,
): Promise<ComparisonResult> {
  const { repo, subject } = request;
  const cwd = subjectCwd(request);
  const mode: CompareMode = baseForcesDirect(base) ? 'direct' : requestedMode;
  // Accumulated as the steps succeed, so the catch block and early returns report how far it got.
  const partial: { -readonly [K in keyof ComparisonResult]?: ComparisonResult[K] } & { excludedUncommitted: { subject?: number; base?: number } } = {
    excludedUncommitted: {},
  };
  const finish = (outcome: ComparisonResult['outcome'], files: readonly ChangedFile[] = [], errorMessage?: string): ComparisonResult => ({
    ...partial,
    repo,
    subject,
    mode,
    outcome,
    files,
    errorMessage,
  });

  try {
    const subjectSide = await resolveSubject(git, cwd, subject, options.includeUntracked);
    partial.subjectRevision = subjectSide.revision;
    partial.excludedUncommitted.subject = subjectSide.excludedUncommitted;
    if (subjectSide.missing) {
      return finish('failed', [], `${subject.label} no longer exists`);
    }

    const resolvedBase = await resolveBase(git, cwd, base, options.includeUntracked);
    if (resolvedBase === undefined) {
      return skipped(request, base, finish, options.logger);
    }
    partial.baseLabel = resolvedBase.label;
    partial.excludedUncommitted.base = resolvedBase.excludedUncommitted;

    const baseRevision = await leftRevision(git, cwd, resolvedBase, mode, subject);
    if (baseRevision === undefined) {
      return skipped(request, base, finish, options.logger);
    }
    partial.baseRevision = baseRevision;

    // Numstat runs alongside name-status: both diff the same sides, and the content diff behind
    // numstat is the slower of the two, so running it afterwards would roughly double the wait.
    const [files, numstat, commits] = await Promise.all([
      subjectSide.revision === undefined
        ? workingTreeChanges(git, cwd, baseRevision, options.includeUntracked)
        : git.diffNameStatus(cwd, baseRevision, subjectSide.revision),
      bestEffortStats(() => git.diffNumstat(cwd, baseRevision, subjectSide.revision), 'diffNumstat', { repo: repo.name, cwd, baseRevision, subjectRevision: subjectSide.revision }, options.logger),
      // A snapshot base is a tree with no history, so there is no commit range to list.
      resolvedBase.tree !== undefined
        ? undefined
        : commitList(git, cwd, baseRevision, subjectSide.revision ?? 'HEAD', { repo: repo.name }, options.logger),
    ]);
    partial.commits = commits;
    const untrackedPaths = files.filter((f) => f.status === 'untracked').map((f) => f.path);
    const logContext = { repo: repo.name, cwd, baseRevision, subjectRevision: subjectSide.revision, fileCount: files.length };
    const [untrackedStats, fingerprinted] = await Promise.all([
      untrackedPaths.length === 0
        ? new Map<string, LineStats>()
        : bestEffortStats(() => git.untrackedLineStats(cwd, untrackedPaths), 'untrackedLineStats', { ...logContext, untrackedCount: untrackedPaths.length }, options.logger),
      withFingerprints(git, cwd, files, baseRevision, subjectSide.revision, logContext, options.logger),
    ]);
    return finish('compared', sortByPath(attachLineStats(fingerprinted, numstat, untrackedStats)));
  } catch (error) {
    options.logger.error('comparison failed', error, {
      function: 'runComparison',
      repo: repo.name,
      cwd,
      subject,
      base,
      mode,
      progress: partial,
    });
    return finish('failed', [], error instanceof Error ? error.message : String(error));
  }
}

/**
 * Right-hand side. `revision` undefined means "the working tree" (uncommitted edits included).
 * `missing` is set when a branch subject no longer resolves (deleted since the view loaded).
 */
async function resolveSubject(
  git: ComparisonPort,
  cwd: string,
  subject: Subject,
  includeUntracked: boolean,
): Promise<{ revision?: string; excludedUncommitted?: number; missing: boolean }> {
  if (subject.kind === 'worktree' && subject.includeUncommitted) {
    return { missing: false };
  }
  const revision = await git.resolveCommit(cwd, subject.kind === 'worktree' ? 'HEAD' : subject.ref);
  // Count what "committed only" leaves out, so the UI can warn instead of silently hiding it.
  const excludedUncommitted = subject.kind === 'worktree' ? await git.uncommittedCount(cwd, includeUntracked) : undefined;
  return { revision, excludedUncommitted, missing: revision === undefined };
}

async function resolveBase(git: ComparisonPort, cwd: string, base: BaseSpec, includeUntracked: boolean): Promise<ResolvedBase | undefined> {
  switch (base.kind) {
    case 'default': {
      const ref = await git.defaultBranch(cwd);
      return ref === undefined ? undefined : { label: ref, commitish: ref };
    }
    case 'ref':
      return { label: base.ref, commitish: base.ref };
    case 'worktree': {
      if (base.includeUncommitted) {
        return { label: base.label, tree: await git.snapshotWorktree(base.root, includeUntracked) };
      }
      // Resolve inside the base worktree: its HEAD is not addressable by name from the subject's cwd.
      const head = await git.resolveCommit(base.root, 'HEAD');
      return head === undefined
        ? undefined
        : { label: base.label, commitish: head, excludedUncommitted: await git.uncommittedCount(base.root, includeUntracked) };
    }
  }
}

async function leftRevision(
  git: ComparisonPort,
  cwd: string,
  base: ResolvedBase,
  mode: CompareMode,
  subject: Subject,
): Promise<string | undefined> {
  if (base.tree !== undefined) {
    return base.tree;
  }
  const commitish = base.commitish ?? '';
  if (mode === 'direct') {
    return git.resolveCommit(cwd, commitish);
  }
  // In a worktree, HEAD is that worktree's own checkout; for a branch subject use the branch.
  return git.mergeBase(cwd, commitish, subject.kind === 'worktree' ? 'HEAD' : subject.ref);
}

async function workingTreeChanges(git: ComparisonPort, cwd: string, baseRevision: string, includeUntracked: boolean): Promise<ChangedFile[]> {
  const [tracked, untracked] = await Promise.all([
    git.diffNameStatus(cwd, baseRevision),
    includeUntracked ? git.untracked(cwd) : Promise.resolve([]),
  ]);
  // A path can be in both lists: intent-to-add files, or files untracked here but present in a
  // snapshot base. The diff's entry is authoritative.
  const trackedPaths = new Set(tracked.map((f) => f.path));
  const newFiles = untracked
    .filter((p) => !trackedPaths.has(p))
    .map((p): ChangedFile => ({ status: 'untracked', path: p, oldPath: p }));
  return [...tracked, ...newFiles];
}

function skipped(
  request: ComparisonRequest,
  base: BaseSpec,
  finish: (outcome: ComparisonResult['outcome']) => ComparisonResult,
  logger: Logger,
): ComparisonResult {
  logger.warn('comparison skipped: base not found', {
    function: 'runComparison',
    repo: request.repo.name,
    subject: request.subject,
    base,
  });
  return finish('ref_missing');
}

/**
 * Run a line-stats query; on failure log WARN (degraded result: files without counts) and return
 * an empty map. Stats never fail the comparison itself.
 */
async function bestEffortStats(
  query: () => Promise<Map<string, LineStats>>,
  operation: string,
  context: Record<string, unknown>,
  logger: Logger,
): Promise<Map<string, LineStats>> {
  try {
    return await query();
  } catch (error) {
    logger.warn('line stats unavailable; showing files without counts', {
      function: 'bestEffortStats',
      operation,
      ...context,
      reason: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/** List the commits `from..to`; on failure log WARN and return undefined (no Commits section). */
async function commitList(
  git: ComparisonPort,
  cwd: string,
  from: string,
  to: string,
  context: Record<string, unknown>,
  logger: Logger,
): Promise<CommitList | undefined> {
  try {
    // One extra to learn whether the list was cut off, without a separate count query.
    const entries = await git.commitsBetween(cwd, from, to, COMMIT_LIMIT + 1);
    return { entries: entries.slice(0, COMMIT_LIMIT), truncated: entries.length > COMMIT_LIMIT };
  } catch (error) {
    logger.warn('commit list unavailable; comparison shown without it', {
      function: 'commitList',
      cwd,
      from,
      to,
      ...context,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Attach fingerprints; on failure log WARN (degraded: files cannot be marked reviewed this run)
 * and return the files unchanged.
 */
async function withFingerprints(
  git: FingerprintPort,
  cwd: string,
  files: readonly ChangedFile[],
  baseRevision: string,
  subjectRevision: string | undefined,
  context: Record<string, unknown>,
  logger: Logger,
): Promise<readonly ChangedFile[]> {
  try {
    return await attachFingerprints(git, cwd, files, baseRevision, subjectRevision);
  } catch (error) {
    logger.warn('fingerprints unavailable; files cannot be marked reviewed', {
      function: 'withFingerprints',
      ...context,
      reason: error instanceof Error ? error.message : String(error),
    });
    return files;
  }
}

// Untracked files are not in the diff, so their counts come from the separate map. A path missing
// from both keeps `lines` undefined (unknown), which the view shows as no count rather than "+0".
function attachLineStats(files: readonly ChangedFile[], numstat: ReadonlyMap<string, LineStats>, untracked: ReadonlyMap<string, LineStats>): ChangedFile[] {
  return files.map((file) => {
    const lines = numstat.get(file.path) ?? untracked.get(file.path);
    return lines === undefined ? file : { ...file, lines };
  });
}

/** Totals over files that have counts; binary and unknown files contribute nothing. */
export function totalLineStats(files: readonly ChangedFile[]): { readonly added: number; readonly deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.lines?.added ?? 0;
    deleted += file.lines?.deleted ?? 0;
  }
  return { added, deleted };
}

function sortByPath(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Where one side of a file diff reads its content from. */
export type SideSource =
  | { readonly kind: 'empty' }
  | { readonly kind: 'file'; readonly absolutePath: string }
  | { readonly kind: 'revision'; readonly cwd: string; readonly revision: string; readonly path: string };

/**
 * Describe both sides of the diff for one changed file.
 *
 * - Left: `baseRevision` at the OLD path (differs from `path` for renames); empty for additions.
 * - Right: the live file on disk when the subject is a working tree (the diff editor is then
 *   editable and reflects saves); otherwise `subjectRevision`. Empty for deletions.
 *
 * Precondition: `result.outcome === 'compared'`.
 */
export function diffSides(result: ComparisonResult, file: ChangedFile): { left: SideSource; right: SideSource } {
  const cwd = result.subject.kind === 'worktree' ? result.subject.root : result.repo.root;
  const left: SideSource =
    file.status === 'added' || file.status === 'untracked' || result.baseRevision === undefined
      ? { kind: 'empty' }
      : { kind: 'revision', cwd, revision: result.baseRevision, path: file.oldPath };
  let right: SideSource;
  if (file.status === 'deleted') {
    right = { kind: 'empty' };
  } else if (result.subjectRevision === undefined) {
    right = { kind: 'file', absolutePath: path.join(cwd, file.path) };
  } else {
    right = { kind: 'revision', cwd, revision: result.subjectRevision, path: file.path };
  }
  return { left, right };
}
