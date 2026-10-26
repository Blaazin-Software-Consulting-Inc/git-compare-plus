/**
 * branchLocation — where a branch "lives" (which worktree has it checked out, if any), and what
 * "Open" will do with it.
 *
 * Why: switching branches and opening worktrees are easy to confuse. Switching changes the files
 * in a folder you may be working in; a worktree is a separate folder that leaves your current work
 * alone. Every branch row therefore says where the branch is, and "Open" states its outcome before
 * anything happens:
 *
 *   in this window        → nothing to do; says so
 *   in another worktree   → open that worktree in a new window (nothing changes on disk)
 *   not checked out       → a choice, each with its consequence spelled out:
 *                             switch this window's worktree to it (refused with uncommitted
 *                             changes; never stashes), or create a worktree for it
 *
 * A remote branch (`origin/x`) lives wherever its local branch `x` does; opening it when `x` does
 * not exist yet creates `x` tracking `origin/x`.
 *
 * Clicking a row and its compare button also do different things (clickHint): a click only lists
 * the row's commits in Commits, a cheap preview; the compare button replaces the comparison in
 * Changes, which holds a review in progress, so it is never done by a plain click.
 *
 * Pure (no `vscode` import); unit-tested in test/branchLocation.test.ts.
 */
import type { RefEntry, WorktreeEntry } from './git/parsers';
import { defaultWorktreePath, localNameForRemote } from './operations';
import { displayPath, isOneOf, samePath } from './paths';

/** Where a branch is checked out, from the point of view of this editor window. */
export type BranchLocation =
  | { readonly kind: 'thisWindow'; readonly worktree: WorktreeEntry }
  | { readonly kind: 'otherWorktree'; readonly worktree: WorktreeEntry }
  | { readonly kind: 'notCheckedOut' };

/**
 * Local branches checked out in no worktree, in their given order: the "Other Branches" group.
 * A branch that is checked out is shown once, under Worktrees (its worktree row), not again here.
 */
export function branchesNotCheckedOut(refs: readonly RefEntry[], worktrees: readonly WorktreeEntry[]): RefEntry[] {
  const checkedOut = new Set(worktrees.flatMap((w) => (w.branch === undefined ? [] : [w.branch])));
  return refs.filter((ref) => ref.kind === 'local' && !checkedOut.has(ref.name));
}

/** The local branch name a ref stands for: itself, or `x` for remote `origin/x`. */
export function localBranchName(ref: RefEntry): string {
  return ref.kind === 'remote' ? localNameForRemote(ref.name) : ref.name;
}

/**
 * Where `ref` lives.
 * @param worktrees - the repo's usable worktrees.
 * @param windowFolders - folders open in this window (workspace folders).
 */
export function branchLocation(ref: RefEntry, worktrees: readonly WorktreeEntry[], windowFolders: readonly string[]): BranchLocation {
  const holder = worktrees.find((w) => w.branch === localBranchName(ref));
  if (holder === undefined) {
    return { kind: 'notCheckedOut' };
  }
  return isOneOf(holder.path, windowFolders) ? { kind: 'thisWindow', worktree: holder } : { kind: 'otherWorktree', worktree: holder };
}

/**
 * Row text for a location: `in this window`, `in main worktree`, `in worktree .wt/x`, or nothing
 * when it is not checked out (the "Other Branches" group already says so). Remote branches say
 * "local copy" so the row does not suggest the remote branch itself is checked out.
 */
export function locationText(location: BranchLocation, ref: RefEntry, repoRoot: string): string {
  const prefix = ref.kind === 'remote' ? 'local copy ' : '';
  switch (location.kind) {
    case 'thisWindow':
      return `${prefix}in this window`;
    case 'otherWorktree':
      return `${prefix}in ${worktreeName(location.worktree, repoRoot)}`;
    case 'notCheckedOut':
      // Every row of "Other Branches" is not checked out, and a remote branch without a local copy
      // is the normal case: saying so on every row is noise.
      return '';
  }
}

/** `main worktree`, or `worktree <short path>`. */
export function worktreeName(worktree: WorktreeEntry, repoRoot: string): string {
  return samePath(worktree.path, repoRoot) ? 'main worktree' : `worktree ${displayPath(repoRoot, worktree.path)}`;
}

/** One way to open a branch that is not checked out; `detail` is the consequence, in full. */
export interface OpenChoice {
  readonly action: 'switch' | 'createWorktree';
  readonly label: string;
  readonly detail: string;
  /** For `switch`: the worktree whose files change. */
  readonly worktree?: WorktreeEntry;
}

/**
 * The choices for a branch that is not checked out.
 * @param switchTarget - the worktree "switch" would change: this window's worktree of the repo,
 *   or the main worktree when this window has none of the repo's worktrees open.
 * @param inWindow - whether `switchTarget` is open in this window (wording only).
 */
export function openChoices(ref: RefEntry, switchTarget: WorktreeEntry, inWindow: boolean, repoRoot: string): OpenChoice[] {
  const local = localBranchName(ref);
  // Opening a remote branch with no local copy creates one; say so on both choices.
  const creates = ref.kind === 'remote' ? ` Creates local branch ${local} tracking ${ref.name}.` : '';
  const target = inWindow ? 'this window' : worktreeName(switchTarget, repoRoot);
  return [
    {
      action: 'switch',
      label: `$(arrow-swap) Switch ${target} to ${local}`,
      detail: `Changes the files in ${displayPath(repoRoot, switchTarget.path) || 'the main worktree'}. Refused if it has uncommitted changes; nothing is stashed for you.${creates}`,
      worktree: switchTarget,
    },
    {
      action: 'createWorktree',
      label: `$(new-folder) Create a worktree for ${local}`,
      detail: `A separate folder (${displayPath(repoRoot, defaultWorktreePath(repoRoot, local))}), opened in a new window. Your current work is untouched.${creates}`,
    },
  ];
}

/**
 * The worktree "switch" acts on: this window's worktree of the repo when one is open here,
 * otherwise the main worktree. Undefined only when the repo has no usable worktree.
 */
export function switchTargetFor(worktrees: readonly WorktreeEntry[], windowFolders: readonly string[]): { worktree: WorktreeEntry; inWindow: boolean } | undefined {
  const here = worktrees.find((w) => isOneOf(w.path, windowFolders));
  if (here !== undefined) {
    return { worktree: here, inWindow: true };
  }
  const main = worktrees[0];
  return main === undefined ? undefined : { worktree: main, inWindow: false };
}

/**
 * The hover line that says what clicking a worktree or branch row does, and what its compare
 * button does instead.
 * @param againstLabel - what the compare button compares with (the repo's default Against, e.g.
 *   `origin/main`); undefined when not known yet, worded generically.
 */
export function clickHint(againstLabel: string | undefined): string {
  const against = againstLabel ?? "the repo's default Against";
  return `Click to list its commits in Commits. The compare button reviews its changes in Changes, against ${against}.`;
}
