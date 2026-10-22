/**
 * stashes — what a stash contains and how its rows and confirmations are worded.
 *
 * A stash is a commit whose parents are: [0] the commit it was made on, [1] the staged state, and
 * [2] (only when made with --include-untracked) a commit holding the untracked files. Its changes
 * are therefore "parent 0 → stash" for tracked files, plus every file of parent 2 as a new file.
 *
 * Stashes belong to the repo, not to a worktree: every worktree sees the same list. Applying one
 * changes the files of one worktree, so the apply/pop actions always say which (this window's
 * worktree of the repo, or the main worktree when none is open here).
 *
 * Pure apart from the injected port; unit-tested in test/stashes.test.ts.
 */
import type { ChangedFile, LineStats, StashEntry } from './git/parsers';
import { formatAge, type ConfirmationText } from './operations';

/** Git access needed to list a stash's files. Implemented by GitCli. */
export interface StashPort {
  diffNameStatus(cwd: string, from: string, to?: string): Promise<ChangedFile[]>;
  diffNumstat(cwd: string, from: string, to?: string): Promise<Map<string, LineStats>>;
  emptyTree(root: string): Promise<string>;
}

/** One file in a stash, with the two revisions its diff reads. */
export interface StashFile {
  readonly file: ChangedFile;
  /** Left side: the commit the stash was made on (tracked files), or empty (untracked files). */
  readonly leftRevision?: string;
  /** Right side: the stash commit, or its untracked-files commit. */
  readonly rightRevision: string;
}

/**
 * Everything a stash changed: tracked files (made-on commit → stash) then untracked files saved
 * with it (shown with the `untracked` status), each list sorted by path.
 */
export async function stashFiles(git: StashPort, cwd: string, stash: StashEntry): Promise<StashFile[]> {
  const base = stash.parents[0];
  const untrackedCommit = stash.parents[2];
  const emptyTree = untrackedCommit === undefined ? undefined : await git.emptyTree(cwd);
  const [tracked, trackedLines, untracked, untrackedLines] = await Promise.all([
    base === undefined ? Promise.resolve([]) : git.diffNameStatus(cwd, base, stash.sha),
    base === undefined ? Promise.resolve(new Map<string, LineStats>()) : git.diffNumstat(cwd, base, stash.sha),
    untrackedCommit === undefined || emptyTree === undefined ? Promise.resolve([]) : git.diffNameStatus(cwd, emptyTree, untrackedCommit),
    untrackedCommit === undefined || emptyTree === undefined ? Promise.resolve(new Map<string, LineStats>()) : git.diffNumstat(cwd, emptyTree, untrackedCommit),
  ]);
  const withLines = (file: ChangedFile, lines: ReadonlyMap<string, LineStats>): ChangedFile => {
    const found = lines.get(file.path);
    return found === undefined ? file : { ...file, lines: found };
  };
  return [
    ...sortByPath(tracked).map((file): StashFile => ({ file: withLines(file, trackedLines), leftRevision: base, rightRevision: stash.sha })),
    ...sortByPath(untracked).map((file): StashFile => ({
      file: { ...withLines(file, untrackedLines), status: 'untracked' },
      rightRevision: untrackedCommit ?? stash.sha,
    })),
  ];
}

/** Row label: the stash message, or `Uncommitted changes on main` for an unnamed stash. */
export function stashLabel(stash: StashEntry): string {
  return stash.named ? stash.message : `Uncommitted changes on ${stash.branch ?? 'a detached commit'}`;
}

/** Row description: `stash@{0} · on main · 3 days ago`. */
export function stashDescription(stash: StashEntry, nowMs: number): string {
  return [stash.ref, stash.branch !== undefined ? `on ${stash.branch}` : undefined, formatAge(stash.createdAt, nowMs)].filter(Boolean).join(' · ');
}

/** Row hover: what the stash holds and what the actions do. */
export function stashTooltip(stash: StashEntry): string {
  const madeOn = stash.named ? '' : `\nMade on ${stash.message}`;
  const untracked = stash.parents.length > 2 ? '\nIncludes untracked files.' : '';
  return `${stashLabel(stash)} (${stash.ref})${madeOn}${untracked}\n\nApply keeps the stash; Pop applies it and removes it; Drop deletes it.`;
}

/** The modal confirmation for Drop: permanent, and says how much is lost. */
export function dropConfirmation(stash: StashEntry, fileCount: number): ConfirmationText {
  return {
    title: `Drop stash "${stashLabel(stash)}"?`,
    detail:
      `${fileCount} changed file${fileCount === 1 ? '' : 's'} in it will be deleted. ` +
      'This cannot be undone from here (git can sometimes recover a dropped stash with `git fsck`, but only until it cleans up).',
    confirm: 'Drop Stash',
  };
}

function sortByPath(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
