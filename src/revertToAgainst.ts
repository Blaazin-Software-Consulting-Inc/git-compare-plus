/**
 * revertToAgainst — plans "Revert to Against" for files in Changes: put each file on disk back to
 * the version on the LEFT side of its diff, as if every one of its blocks were reverted.
 *
 * Why a whole-file command: the diff editor's own Revert Block works one block at a time, and not
 * at all for files that are added or deleted.
 *
 * What "back to the left side" means per status (left = `baseRevision` at `oldPath`):
 *   modified          → restore `path` from the left side
 *   deleted           → restore it (recreated)
 *   renamed           → restore `oldPath`, and move `path` to the Trash
 *   added / untracked → move `path` to the Trash (the left side has no such file)
 * Files are restored with `git restore --worktree` (GitCli.restoreFromRevision): the index and
 * commits are untouched, so the result is uncommitted edits the user can review and commit.
 * Removed files go to the Trash rather than being deleted, so they can be recovered.
 *
 * Only offered when the right side is the files on disk (a worktree reviewed WITH its uncommitted
 * edits): a branch or a committed-only review has no files of its own to change.
 *
 * The left side is the branch point in merge-base mode, not the Against side's tip, when the
 * Against side has moved on; the confirmation names which (`leftSideName`), since that is the
 * version the files become.
 *
 * Pure (no `vscode` import); unit-tested in test/revertToAgainst.test.ts. Wiring: revertCommand.ts.
 */
import type { ComparisonResult } from './comparison';
import type { ChangedFile } from './git/parsers';
import type { ConfirmationText } from './operations';

/** What reverting the selected files of one comparison does. Paths are repo-relative. */
export interface RevertPlan {
  readonly result: ComparisonResult;
  /** The files being reverted, once each, as Changes lists them. */
  readonly files: readonly ChangedFile[];
  /** Worktree root git runs in (the subject's files on disk). */
  readonly root: string;
  /** Revision the files are restored from: the left side of the diff. */
  readonly revision: string;
  /** Written from `revision` (overwritten or recreated). */
  readonly restore: readonly string[];
  /** Moved to the Trash: they do not exist on the left side. */
  readonly remove: readonly string[];
  /** Overwritten paths with uncommitted edits: those edits are lost (commits keep the rest). */
  readonly losesUncommitted: readonly string[];
}

/**
 * Why `result`'s files cannot be reverted, or undefined when they can.
 * @returns a sentence for the UI.
 */
export function revertUnavailableReason(result: ComparisonResult): string | undefined {
  if (result.outcome !== 'compared' || result.baseRevision === undefined) {
    return 'This comparison has no Against side to revert to.';
  }
  // A branch, or a worktree reviewed without its uncommitted edits: the right side is a commit.
  if (result.subject.kind !== 'worktree' || result.subjectRevision !== undefined) {
    return 'Only files on disk can be reverted: review a worktree with its uncommitted edits included.';
  }
  return undefined;
}

/**
 * Plan the revert of `files`, all from `result`. Duplicate files (a row selected twice) count once.
 * @returns the plan, or the reason it is unavailable (revertUnavailableReason).
 */
export function planRevert(result: ComparisonResult, files: readonly ChangedFile[]): RevertPlan | { readonly reason: string } {
  const reason = revertUnavailableReason(result);
  // The type guards below repeat what revertUnavailableReason checked, for the compiler.
  if (reason !== undefined || result.subject.kind !== 'worktree' || result.baseRevision === undefined) {
    return { reason: reason ?? 'This comparison has no Against side to revert to.' };
  }
  const unique = [...new Map(files.map((file) => [file.path, file])).values()];
  const restore = new Set<string>();
  const remove = new Set<string>();
  const losesUncommitted = new Set<string>();
  for (const file of unique) {
    switch (file.status) {
      case 'modified':
      case 'deleted':
        restore.add(file.oldPath);
        break;
      case 'renamed':
        restore.add(file.oldPath);
        remove.add(file.path);
        break;
      case 'added':
      case 'untracked':
        remove.add(file.path);
        break;
    }
    // Only an overwritten file loses its edits: a trashed one can be restored from the Trash,
    // and a deleted one has no content on disk to lose.
    if (file.status === 'modified' && file.origin?.uncommitted !== undefined) {
      losesUncommitted.add(file.path);
    }
  }
  return {
    result,
    files: unique,
    root: result.subject.root,
    revision: result.baseRevision,
    restore: [...restore].sort(),
    remove: [...remove].sort(),
    losesUncommitted: [...losesUncommitted].sort(),
  };
}

/**
 * The version the files become, in words: the Against side itself (`origin/main`), or, when the
 * left side is a branch point the Against side has moved on from, `the branch point a1b2c3d of
 * origin/main`. Matches the "Showing: changes since branch point" row in Changes.
 */
export function leftSideName(result: ComparisonResult): string {
  const against = result.baseLabel ?? 'the Against side';
  const atTip = result.mode === 'direct' || result.branchPoint === undefined || result.branchPoint.isAgainstTip;
  if (atTip || result.baseRevision === undefined) {
    return against;
  }
  return `the branch point ${result.baseRevision.slice(0, 7)} of ${against}`;
}

/**
 * The modal dialog for `plans` (one per repo involved). Names every file that changes, which go
 * to the Trash, and which lose uncommitted edits: those edits exist nowhere else.
 */
export function revertConfirmation(plans: readonly RevertPlan[]): ConfirmationText {
  const restore = plans.flatMap((p) => p.restore.map((file) => label(p, plans, file)));
  const remove = plans.flatMap((p) => p.remove.map((file) => label(p, plans, file)));
  const lost = plans.flatMap((p) => p.losesUncommitted.map((file) => label(p, plans, file)));
  const fileCount = plans.reduce((sum, p) => sum + p.files.length, 0);
  // Several repos have one Against side each: name it only when there is one.
  const target = plans.length === 1 && plans[0] !== undefined ? leftSideName(plans[0].result) : 'their Against sides';
  const subject = fileCount === 1 ? (plans[0]?.files[0]?.path ?? '1 file') : `${fileCount} files`;
  const lines = [
    restore.length > 0 ? `Replaced with the version at ${target}: ${restore.join(', ')}.` : '',
    remove.length > 0 ? `Moved to the Trash (not at ${target}): ${remove.join(', ')}.` : '',
    lost.length > 0
      ? `Uncommitted edits are lost: ${lost.join(', ')}.`
      : 'No uncommitted edits are lost: committed versions stay in git history.',
    'Nothing is committed: the result shows as uncommitted edits.',
  ];
  return {
    title: `Revert ${subject} to ${target}?`,
    detail: lines.filter((line) => line.length > 0).join('\n'),
    confirm: 'Revert',
  };
}

// The file's name for the dialog, prefixed with its repo when several repos are involved.
function label(plan: RevertPlan, plans: readonly RevertPlan[], file: string): string {
  return plans.length > 1 ? `${plan.result.repo.name}: ${file}` : file;
}
