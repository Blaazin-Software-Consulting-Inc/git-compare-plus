/**
 * goTo — the entries of "Go to…" (opened from the status bar): every worktree and branch of the
 * window's repo, each saying what picking it will do.
 *
 *   Worktrees   "this window" (nothing happens) or "opens in a new window"
 *   Branches    by where they live (branchLocation.ts): this window / opens worktree X /
 *               not checked out, so you choose to switch or create a worktree
 *
 * Also decides which worktree the status bar describes: the one holding the active editor's
 * file, otherwise the first worktree open in this window.
 *
 * Pure (no `vscode` import); unit-tested in test/goTo.test.ts.
 */
import * as path from 'node:path';
import { branchLocation, localBranchName, worktreeName } from './branchLocation';
import type { RepoInfo } from './comparison';
import type { RefEntry, WorktreeEntry } from './git/parsers';
import { displayPath, isOneOf, samePath } from './paths';

/** One entry of Go to…; `outcome` is what picking it does, shown as its description. */
export type GoToEntry =
  | { readonly kind: 'worktree'; readonly worktree: WorktreeEntry; readonly label: string; readonly outcome: string; readonly detail: string; readonly inWindow: boolean }
  | { readonly kind: 'branch'; readonly ref: RefEntry; readonly label: string; readonly outcome: string };

/** Build Go to… for one repo: worktrees first (this window's first), then local, then remote branches. */
export function goToEntries(repo: RepoInfo, worktrees: readonly WorktreeEntry[], refs: readonly RefEntry[], windowFolders: readonly string[]): GoToEntry[] {
  const worktreeEntries = worktrees
    .map((worktree): GoToEntry => {
      const inWindow = isOneOf(worktree.path, windowFolders);
      return {
        kind: 'worktree',
        worktree,
        label: worktree.branch ?? `detached @ ${(worktree.head ?? '').slice(0, 7)}`,
        outcome: inWindow ? 'this window' : 'opens in a new window',
        detail: worktreeName(worktree, repo.root),
        inWindow,
      };
    })
    .sort((a, b) => Number(b.kind === 'worktree' && b.inWindow) - Number(a.kind === 'worktree' && a.inWindow));
  const branchEntries = [...refs]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'local' ? -1 : 1))
    .map((ref): GoToEntry => ({ kind: 'branch', ref, label: ref.name, outcome: branchOutcome(ref, worktrees, windowFolders, repo.root) }));
  return [...worktreeEntries, ...branchEntries];
}

function branchOutcome(ref: RefEntry, worktrees: readonly WorktreeEntry[], windowFolders: readonly string[], repoRoot: string): string {
  const location = branchLocation(ref, worktrees, windowFolders);
  switch (location.kind) {
    case 'thisWindow':
      return 'this window';
    case 'otherWorktree':
      return `opens ${worktreeName(location.worktree, repoRoot)} in a new window`;
    case 'notCheckedOut':
      return ref.kind === 'remote'
        ? `not checked out: switch to it or create a worktree (creates ${localBranchName(ref)})`
        : 'not checked out: switch to it or create a worktree';
  }
}

/** The repo and worktree this window is "on", for the status bar. */
export interface WindowWorktree {
  readonly repo: RepoInfo;
  readonly worktree: WorktreeEntry;
}

/**
 * Which worktree the status bar describes.
 * @param candidates - each repo with its usable worktrees.
 * @param activeFile - absolute path of the active editor's file, if any.
 * @returns the worktree containing `activeFile` (deepest match, since linked worktrees can sit
 *   inside the main one), else the first worktree open in this window, else undefined.
 */
export function windowWorktree(
  candidates: readonly { readonly repo: RepoInfo; readonly worktrees: readonly WorktreeEntry[] }[],
  windowFolders: readonly string[],
  activeFile: string | undefined,
): WindowWorktree | undefined {
  const open = candidates.flatMap(({ repo, worktrees }) => worktrees.filter((w) => isOneOf(w.path, windowFolders)).map((worktree) => ({ repo, worktree })));
  if (activeFile !== undefined) {
    const containing = open
      .filter(({ worktree }) => isInside(activeFile, worktree.path))
      .sort((a, b) => b.worktree.path.length - a.worktree.path.length)[0];
    if (containing !== undefined) {
      return containing;
    }
  }
  return open[0];
}

/** Status bar text: `repo folder` or the worktree folder's short path. */
export function statusText(current: WindowWorktree): string {
  return samePath(current.worktree.path, current.repo.root) ? 'repo folder' : displayPath(current.repo.root, current.worktree.path);
}

// Git prints forward slashes; editor paths use the platform separator. Compare in one form.
function isInside(file: string, folder: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
