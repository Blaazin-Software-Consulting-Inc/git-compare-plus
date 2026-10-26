/**
 * uncommitted — wording for a worktree's uncommitted work: the `✎ 3 uncommitted` marker on its
 * Repositories row, its hover, and the "Uncommitted changes" row in the Commits view.
 *
 * Why: ahead/behind counts commits only, so without this a worktree with a dozen edited files
 * looked exactly like a clean one in the two places you look to see what is going on in it.
 *
 * Pure; unit-tested in test/uncommitted.test.ts.
 */
import type { StatusCounts } from './git/parsers';

/** Row marker: `✎ 3 uncommitted`, or '' for a clean worktree (or unknown counts). */
export function uncommittedText(counts: StatusCounts | undefined): string {
  return counts === undefined || counts.total === 0 ? '' : `✎ ${counts.total} uncommitted`;
}

/**
 * Hover line: `3 uncommitted files: 1 staged, 2 changed but not staged, 1 untracked`; undefined
 * for a clean worktree. Kinds can overlap (a file both staged and changed again), so the parts may
 * add up to more than the total.
 */
export function uncommittedTooltip(counts: StatusCounts | undefined): string | undefined {
  if (counts === undefined || counts.total === 0) {
    return undefined;
  }
  const parts = [
    counts.staged > 0 ? `${counts.staged} staged` : undefined,
    counts.unstaged > 0 ? `${counts.unstaged} changed but not staged` : undefined,
    counts.untracked > 0 ? `${counts.untracked} untracked` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${counts.total} uncommitted file${counts.total === 1 ? '' : 's'}: ${parts.join(', ')}`;
}
