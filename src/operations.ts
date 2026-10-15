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
