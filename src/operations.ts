/**
 * operations — safety checks and naming rules for the git actions in the Repositories view
 * (fetch, create/remove worktree, create/delete/switch branch).
 *
 * Why separate from the UI (gitActions.ts): every destructive action follows the same pattern —
 * inspect what would be lost, tell the user in a confirmation, then act. The "inspect" half and
 * the naming rules live here, free of `vscode`, so they are tested against real git
 * (test/operations.integration.test.ts) and pure inputs.
 *
 * Safety rules enforced by these checks (the UI must not bypass them):
 *   - Remove worktree: count uncommitted + untracked files first; force removal only after the
 *     user confirmed losing exactly that many files.
 *   - Delete branch: refuse when checked out in ANY worktree; count commits not on the repo's
 *     default branch and require confirmation when there are any (or when it cannot be checked).
 *   - Switch branch: only in the main worktree, and refused while it has tracked uncommitted
 *     changes (never carried over or stashed silently).
 */
import * as path from 'node:path';
import type { WorktreeEntry } from './git/parsers';

/** The git calls the checks need. Implemented by GitCli. */
export interface OperationsPort {
  uncommittedCount(root: string, includeUntracked: boolean): Promise<number>;
  defaultBranch(cwd: string): Promise<string | undefined>;
  commitsNotIn(cwd: string, branch: string, base: string): Promise<number>;
}

/** What removing a worktree would destroy. */
export interface WorktreeRemovalCheck {
  /** Uncommitted + untracked files that would be deleted with the folder. */
  readonly uncommittedFiles: number;
  /** Created by Claude Code (`.claude/worktrees/…`); a running Claude session may still use it. */
  readonly isClaudeWorktree: boolean;
}

/** Inspect a worktree before removal. */
export async function checkWorktreeRemoval(git: OperationsPort, worktreePath: string): Promise<WorktreeRemovalCheck> {
  return {
    uncommittedFiles: await git.uncommittedCount(worktreePath, true),
    isClaudeWorktree: worktreePath.split(path.sep).join('/').includes('/.claude/worktrees/'),
  };
}

/** Whether a local branch can be deleted, and what would be lost. */
export type BranchDeletionCheck =
  | { readonly kind: 'blocked'; readonly checkedOutIn: string }
  | { readonly kind: 'ok'; readonly comparedWith: string; readonly unmergedCommits: number }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Inspect a local branch before deletion.
 * @param worktrees - the repo's worktrees; a branch checked out in any of them cannot be deleted.
 */
export async function checkBranchDeletion(
  git: OperationsPort,
  repoRoot: string,
  branch: string,
  worktrees: readonly WorktreeEntry[],
): Promise<BranchDeletionCheck> {
  const holder = worktrees.find((w) => w.branch === branch);
  if (holder !== undefined) {
    return { kind: 'blocked', checkedOutIn: holder.path };
  }
  const base = await git.defaultBranch(repoRoot);
  // Without a default branch there is nothing meaningful to measure "unmerged" against; the UI
  // then requires the stronger "delete anyway" confirmation.
  if (base === undefined) {
    return { kind: 'unknown', reason: 'no default branch found to check against' };
  }
  return { kind: 'ok', comparedWith: base, unmergedCommits: await git.commitsNotIn(repoRoot, branch, base) };
}

/**
 * Tracked uncommitted changes that block switching the main worktree's branch. Untracked files
 * are not counted: `git switch` carries them over and refuses on its own if one would be overwritten.
 */
export function switchBlockers(git: OperationsPort, mainWorktreeRoot: string): Promise<number> {
  return git.uncommittedCount(mainWorktreeRoot, false);
}

/**
 * Local branch name for a remote-tracking branch: `origin/feature/x` → `feature/x`.
 * Only the first segment (the remote name) is removed; branch names may contain `/`.
 */
export function localNameForRemote(remoteRef: string): string {
  const slash = remoteRef.indexOf('/');
  return slash === -1 ? remoteRef : remoteRef.slice(slash + 1);
}

/**
 * Suggested folder for a new worktree: a sibling of the repo, `<parent>/<repo>.worktrees/<branch>`.
 * Outside the repo so it never shows up as untracked files in the main worktree, and grouped per
 * repo so a workspace of many repos stays tidy. The branch is flattened into one folder name.
 */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const folder = branch.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`, folder);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; `never` for `undefined`. */
export function formatAge(fetchedAtMs: number | undefined, nowMs: number): string {
  if (fetchedAtMs === undefined) {
    return 'never';
  }
  const minutes = Math.max(0, Math.floor((nowMs - fetchedAtMs) / 60_000));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** True when a repo has never been fetched or not within `maxAgeHours`. */
export function isFetchStale(fetchedAtMs: number | undefined, nowMs: number, maxAgeHours: number): boolean {
  return fetchedAtMs === undefined || nowMs - fetchedAtMs > maxAgeHours * 3_600_000;
}

/** Run `task` over `items` with at most `limit` in flight; results in input order. Never rejects. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  // Each worker pulls the next index until none remain; `next++` is safe because JS is single-threaded.
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------------------------
// Bulk deletion (multi-select). One confirmation for N items: the dialog lists every item with
// what it would lose, then the total, and the confirm button repeats the total so it cannot be
// missed. Items that cannot be deleted are listed as skipped rather than silently dropped.
// ---------------------------------------------------------------------------------------------

/** Lines of the per-item list shown before collapsing the rest into "…and N more". */
const MAX_LISTED_ITEMS = 15;

/** Text for a modal confirmation: `title` is the message, `detail` the body, `confirm` the button. */
export interface ConfirmationText {
  readonly title: string;
  readonly detail: string;
  readonly confirm: string;
}

/** A local branch selected for deletion, with its pre-deletion check. */
export interface BranchCandidate {
  readonly repoName: string;
  readonly branch: string;
  readonly check: BranchDeletionCheck;
}

/** A selected item that will not be deleted, and why (shown in the dialog / message). */
export interface SkippedItem {
  readonly label: string;
  readonly reason: string;
}

/**
 * Split branch candidates into deletable and skipped (checked out somewhere) and word the single
 * confirmation. `confirmation` is undefined when nothing is deletable; `skipped` then explains why.
 * @param extraSkipped - items rejected before checking (e.g. remote branches in the selection).
 */
export function planBranchDeletions(
  candidates: readonly BranchCandidate[],
  extraSkipped: readonly SkippedItem[] = [],
): { deletable: BranchCandidate[]; skipped: SkippedItem[]; confirmation?: ConfirmationText } {
  const multiRepo = new Set(candidates.map((c) => c.repoName)).size > 1;
  const label = (c: BranchCandidate): string => (multiRepo ? `${c.repoName}: ${c.branch}` : c.branch);
  const deletable = candidates.filter((c) => c.check.kind !== 'blocked');
  const skipped: SkippedItem[] = [
    ...candidates.flatMap((c) => (c.check.kind === 'blocked' ? [{ label: label(c), reason: `checked out in ${c.check.checkedOutIn}` }] : [])),
    ...extraSkipped,
  ];
  if (deletable.length === 0) {
    return { deletable, skipped };
  }

  let lostCommits = 0;
  let unknown = 0;
  const lines = deletable.map((c) => {
    if (c.check.kind === 'ok') {
      lostCommits += c.check.unmergedCommits;
      return c.check.unmergedCommits > 0
        ? `• ${label(c)}: ${plural(c.check.unmergedCommits, 'commit')} not in ${c.check.comparedWith} will be lost`
        : `• ${label(c)}: all commits are in ${c.check.comparedWith}`;
    }
    unknown++;
    return `• ${label(c)}: could not check for unmerged commits`;
  });

  const only = deletable.length === 1 ? deletable[0] : undefined;
  const title = only !== undefined ? `Delete branch ${label(only)}?` : `Delete ${deletable.length} branches?`;
  const detail = [
    ...truncateList(lines),
    ...(lostCommits > 0 ? ['', `${plural(lostCommits, 'commit')} in total will be lost (recoverable from the reflog for a limited time).`] : []),
    ...skippedSection(skipped),
    '',
    'Remote branches are not affected.',
  ].join('\n');
  const confirm =
    lostCommits > 0
      ? `Delete and Lose ${plural(lostCommits, 'Commit')}`
      : unknown > 0
        ? 'Delete Anyway'
        : only !== undefined
          ? 'Delete Branch'
          : `Delete ${deletable.length} Branches`;
  return { deletable, skipped, confirmation: { title, detail, confirm } };
}

/** A linked worktree selected for removal, with its pre-removal check. */
export interface WorktreeCandidate {
  readonly repoName: string;
  /** Branch name, or folder name when detached. */
  readonly name: string;
  readonly path: string;
  readonly detached: boolean;
  readonly check: WorktreeRemovalCheck;
}

/**
 * Word the single confirmation for removing one or more worktrees.
 * @param skipped - selected items that are not removable (e.g. a main worktree).
 */
export function planWorktreeRemovals(candidates: readonly WorktreeCandidate[], skipped: readonly SkippedItem[] = []): ConfirmationText | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const multiRepo = new Set(candidates.map((c) => c.repoName)).size > 1;
  const label = (c: WorktreeCandidate): string => (multiRepo ? `${c.repoName}: ${c.name}` : c.name);
  const lostFiles = candidates.reduce((total, c) => total + c.check.uncommittedFiles, 0);
  const lines = candidates.map(
    (c) =>
      `• ${label(c)}: ${c.path}${c.check.uncommittedFiles > 0 ? `, ${plural(c.check.uncommittedFiles, 'uncommitted file')} will be PERMANENTLY DELETED` : ''}`,
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const detail = [
    ...truncateList(lines),
    '',
    candidates.some((c) => c.detached)
      ? 'Branches and their commits are kept. Commits made only in a detached worktree become unreachable.'
      : 'The folders are deleted; branches and their commits are kept.',
    ...(lostFiles > 0 && only === undefined ? [`${plural(lostFiles, 'uncommitted file')} in total will be permanently deleted.`] : []),
    ...(candidates.some((c) => c.check.isClaudeWorktree)
      ? ['Created by Claude Code: if a Claude session is still using one of these, that session will break.']
      : []),
    ...skippedSection(skipped),
  ].join('\n');
  return {
    title: only !== undefined ? `Remove worktree ${label(only)}?` : `Remove ${candidates.length} worktrees?`,
    detail,
    confirm: lostFiles > 0 ? `Remove and Discard ${plural(lostFiles, 'File')}` : only !== undefined ? 'Remove Worktree' : `Remove ${candidates.length} Worktrees`,
  };
}

function skippedSection(skipped: readonly SkippedItem[]): string[] {
  return skipped.length === 0 ? [] : ['', 'Skipped:', ...truncateList(skipped.map((s) => `• ${s.label}: ${s.reason}`))];
}

function truncateList(lines: readonly string[]): string[] {
  return lines.length <= MAX_LISTED_ITEMS
    ? [...lines]
    : [...lines.slice(0, MAX_LISTED_ITEMS), `…and ${lines.length - MAX_LISTED_ITEMS} more`];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Items a context-menu command should act on. VS Code passes the right-clicked item plus the
 * whole selection when the tree allows multi-select; right-clicking OUTSIDE the selection passes
 * a selection that does not contain the item, and then only the clicked item is meant.
 */
export function selectionTargets<T>(clicked: T | undefined, selection: readonly T[] | undefined): T[] {
  if (selection !== undefined && selection.length > 0 && (clicked === undefined || selection.includes(clicked))) {
    return [...selection];
  }
  return clicked === undefined ? [] : [clicked];
}
