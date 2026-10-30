/**
 * changeOrigin — whether each file in a comparison changed through commits, uncommitted edits, or
 * both, so the Changes view can mark the uncommitted ones (`✎`, the same mark the Repositories
 * rows use for uncommitted work).
 *
 * Why: reviewing a worktree "INCLUDING uncommitted edits" diffs the left side against the files on
 * disk, which folds commits and edits-in-progress into one diff. Without a mark, a reviewer cannot
 * tell what is already committed from what is still being worked on.
 *
 * How (comparison.ts supplies both inputs, from the subject worktree):
 *   - committed paths:   `git diff --name-status <left> HEAD` (old and new path of each entry)
 *   - uncommitted paths: `git status --porcelain` (parseStatusPaths), honouring .gitignore and the
 *                        includeUntracked setting like the file list itself
 * A file is matched under its new or its old path, so a rename on either side is still found. A
 * file in neither list (possible only if the disk changed between the git calls) gets no origin
 * and so no mark; the next refresh corrects it.
 *
 * Pure (no `vscode` import); unit-tested in test/changeOrigin.test.ts.
 */
import type { ChangedFile, ChangeOrigin, UncommittedState } from './git/parsers';

/**
 * Attach `origin` to each file.
 * @param committedPaths - every path (old and new) in the left side ↔ HEAD diff.
 * @param uncommitted - uncommitted paths of the subject worktree with their state.
 * @returns new file objects in the same order; a file found in neither input is returned as is.
 */
export function attachOrigins(
  files: readonly ChangedFile[],
  committedPaths: ReadonlySet<string>,
  uncommitted: ReadonlyMap<string, UncommittedState>,
): ChangedFile[] {
  return files.map((file) => {
    const committed = committedPaths.has(file.path) || committedPaths.has(file.oldPath);
    const state = uncommitted.get(file.path) ?? uncommitted.get(file.oldPath);
    if (!committed && state === undefined) {
      return file;
    }
    const origin: ChangeOrigin = state === undefined ? { committed } : { committed, uncommitted: state };
    return { ...file, origin };
  });
}

/** Every path a name-status diff touches: new paths, and old paths of renames. */
export function touchedPaths(files: readonly ChangedFile[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    paths.add(file.oldPath);
  }
  return paths;
}

/** The row mark: `✎` when the file has uncommitted edits, otherwise nothing. */
export function originMark(origin: ChangeOrigin | undefined): string {
  return origin?.uncommitted === undefined ? '' : '✎';
}

/**
 * Hover line saying where the change comes from, or undefined when unknown (no origin: a branch,
 * a committed-only worktree, or a failed lookup).
 */
export function originTooltip(origin: ChangeOrigin | undefined): string | undefined {
  if (origin === undefined) {
    return undefined;
  }
  if (origin.uncommitted === undefined) {
    return 'Committed: no uncommitted edits.';
  }
  const edits = uncommittedKinds(origin.uncommitted);
  return origin.committed ? `✎ Committed, plus uncommitted edits (${edits}).` : `✎ Uncommitted only (${edits}): not in any commit yet.`;
}

/** How many files have uncommitted edits (for the Reviewing header row). */
export function uncommittedFileCount(files: readonly ChangedFile[]): number {
  let count = 0;
  for (const file of files) {
    if (file.origin?.uncommitted !== undefined) {
      count++;
    }
  }
  return count;
}

// `staged and not staged`, `staged`, `not staged`, or `untracked`.
function uncommittedKinds(state: UncommittedState): string {
  if (state.untracked) {
    return 'untracked';
  }
  return [state.staged ? 'staged' : undefined, state.unstaged ? 'not staged' : undefined].filter(Boolean).join(' and ') || 'staged';
}
