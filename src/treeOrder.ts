/**
 * treeOrder — display order for branches and worktrees (Repositories view, Compare With… picker).
 *
 * Rule (user request): the integration branch first, then everything else newest first.
 *   1. Pinned: the repo's default branch (from `origin/HEAD`), then `main`, then `master`.
 *      Remote branches are matched by their name without the remote (`origin/main` → `main`).
 *   2. Then by committer date of the branch tip / worktree HEAD, most recent first, so the
 *      branch or worktree you are working on right now is near the top.
 *   3. Ties (same date, or no date) by name, for a stable order.
 * The main worktree is always first in the Worktrees group regardless of its branch.
 *
 * Pure; unit-tested in test/treeOrder.test.ts.
 */
import type { RefEntry, WorktreeEntry } from './git/parsers';
import { localNameForRemote } from './operations';

/** Conventional integration branch names, pinned after the repo's own default branch. */
const PINNED_NAMES: readonly string[] = ['main', 'master'];

/**
 * Pin rank for a branch name (lower = earlier), or `undefined` when not pinned.
 * @param defaultBranch - the repo's default branch as git reports it (`origin/master`), if known.
 */
function pinRank(localName: string, defaultBranch: string | undefined): number | undefined {
  if (defaultBranch !== undefined && localName === localNameForRemote(defaultBranch)) {
    return 0;
  }
  const index = PINNED_NAMES.indexOf(localName);
  return index === -1 ? undefined : index + 1;
}

/** Shared comparator: pinned first (by rank), then newest first, then name. */
function compareEntries(
  a: { name: string; pin: number | undefined; date: number | undefined },
  b: { name: string; pin: number | undefined; date: number | undefined },
): number {
  if (a.pin !== b.pin) {
    return (a.pin ?? Number.MAX_SAFE_INTEGER) - (b.pin ?? Number.MAX_SAFE_INTEGER);
  }
  if (a.date !== b.date) {
    // Undated entries (should not happen for real refs) sink below dated ones.
    return (b.date ?? Number.NEGATIVE_INFINITY) - (a.date ?? Number.NEGATIVE_INFINITY);
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Branches in display order. Local and remote branches are sorted by the same rule; callers that
 * show them in separate groups filter afterwards (order is preserved).
 */
export function sortBranches(refs: readonly RefEntry[], defaultBranch: string | undefined): RefEntry[] {
  return refs
    .map((ref) => ({
      ref,
      key: {
        name: ref.name,
        pin: pinRank(ref.kind === 'remote' ? localNameForRemote(ref.name) : ref.name, defaultBranch),
        date: ref.committedAt,
      },
    }))
    .sort((a, b) => compareEntries(a.key, b.key))
    .map(({ ref }) => ref);
}

/**
 * Worktrees in display order: the main worktree (git lists it first) always first, then worktrees
 * on a pinned branch, then newest HEAD commit first.
 * @param commitDates - HEAD SHA → committer date (ms), from GitCli.commitDates.
 */
export function sortWorktrees(
  worktrees: readonly WorktreeEntry[],
  defaultBranch: string | undefined,
  commitDates: ReadonlyMap<string, number>,
): WorktreeEntry[] {
  const [main, ...linked] = worktrees;
  if (main === undefined) {
    return [];
  }
  const sorted = linked
    .map((worktree) => ({
      worktree,
      key: {
        name: worktree.branch ?? worktree.path,
        pin: worktree.branch === undefined ? undefined : pinRank(worktree.branch, defaultBranch),
        date: worktree.head === undefined ? undefined : commitDates.get(worktree.head),
      },
    }))
    .sort((a, b) => compareEntries(a.key, b.key))
    .map(({ worktree }) => worktree);
  return [main, ...sorted];
}
