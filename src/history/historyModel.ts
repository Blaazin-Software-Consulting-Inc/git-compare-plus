/**
 * historyModel — what the History view shows and how stepping through a file's versions works.
 *
 * Two modes:
 *   - file: every commit that changed the file, following renames (`git log --follow`); each entry
 *     knows the file's path in that commit.
 *   - lines: commits that changed a range of lines (`git log -L`); the path is today's path.
 *
 * "Previous version" of an entry (the left side of its diff):
 *   - file mode: the next OLDER entry, at its own path. The file did not change between the two
 *     (that is what the history lists), so this equals the commit's parent version, and it handles
 *     renames for free;
 *   - when there is no older entry: empty if the commit added the file or has no parent, otherwise
 *     the parent (the list was cut off at the limit);
 *   - lines mode: always the first parent at today's path.
 *
 * Stepping (editor title ◀ ▶) moves the RIGHT side of the diff one version at a time:
 *   working file → newest commit → … → oldest commit, and back. The left side is always the
 *   version just before the right side. From a plain editor with uncommitted changes, the first
 *   step back shows those changes (newest commit ↔ working file).
 *
 * Pure (no `vscode` import); unit-tested in test/historyModel.test.ts.
 */
import type { CommitEntry } from '../git/parsers';

/** Commits listed per history; the list says when there are more. */
export const HISTORY_LIMIT = 200;

/** One history row: a commit and the file's path in it. */
export interface HistoryEntry {
  readonly commit: CommitEntry;
  readonly path: string;
  /** First letter of git's name-status (`A`, `M`, `R`, …); `M` in lines mode. */
  readonly status: string;
}

/** What the History view is showing. */
export interface HistoryState {
  readonly mode: 'file' | 'lines';
  /** Worktree root. */
  readonly root: string;
  /** Repo-relative path of the file today. */
  readonly path: string;
  /** 1-based inclusive line range, lines mode only. */
  readonly lines?: { readonly start: number; readonly end: number };
  readonly entries: readonly HistoryEntry[];
  /** True when more than HISTORY_LIMIT commits exist. */
  readonly truncated: boolean;
}

/** A version of the file: at a commit (with its path there), or empty (before it existed). */
export type FileVersion = { readonly kind: 'commit'; readonly sha: string; readonly path: string } | { readonly kind: 'empty' };

/** The left side for entry `index` (see module doc). */
export function previousVersion(state: Pick<HistoryState, 'mode' | 'entries' | 'truncated' | 'path'>, index: number): FileVersion {
  const entry = state.entries[index];
  if (entry === undefined) {
    return { kind: 'empty' };
  }
  const parent = entry.commit.parents[0];
  if (state.mode === 'lines') {
    return parent === undefined ? { kind: 'empty' } : { kind: 'commit', sha: parent, path: state.path };
  }
  const older = state.entries[index + 1];
  if (older !== undefined) {
    return { kind: 'commit', sha: older.commit.sha, path: older.path };
  }
  if (entry.status === 'A' || parent === undefined || !state.truncated) {
    // Oldest listed and the full history was listed: the commit created the file.
    return { kind: 'empty' };
  }
  return { kind: 'commit', sha: parent, path: entry.path };
}

/** Where the active editor is in a file's history. */
export type HistoryPosition =
  | { readonly kind: 'working'; readonly inDiff: boolean; readonly uncommitted: boolean }
  | { readonly kind: 'commit'; readonly index: number };

/** The diff to open after a step: its right side is an entry, or the working file. */
export type StepResult =
  | { readonly kind: 'open'; readonly right: number | 'working' }
  | { readonly kind: 'message'; readonly text: string };

/** One step back (`previous`) or forward (`next`) through a file's versions. */
export function step(position: HistoryPosition, direction: 'previous' | 'next', entryCount: number): StepResult {
  if (entryCount === 0) {
    return { kind: 'message', text: 'This file has no committed history yet.' };
  }
  if (position.kind === 'working') {
    if (direction === 'next') {
      return { kind: 'message', text: 'This is already the newest version (the file as it is now).' };
    }
    // From a plain editor with uncommitted changes, the first step shows those changes.
    return { kind: 'open', right: !position.inDiff && position.uncommitted ? 'working' : 0 };
  }
  if (direction === 'previous') {
    return position.index + 1 < entryCount
      ? { kind: 'open', right: position.index + 1 }
      : { kind: 'message', text: 'This is the oldest version in the history.' };
  }
  return { kind: 'open', right: position.index === 0 ? 'working' : position.index - 1 };
}

/** View title description: `file history · 37 commits` or `lines 12–20 · 5 commits` (`200+`). */
export function historyDescription(state: HistoryState): string {
  const count = `${state.entries.length}${state.truncated ? '+' : ''} commit${state.entries.length === 1 && !state.truncated ? '' : 's'}`;
  return state.mode === 'lines' && state.lines !== undefined
    ? `lines ${state.lines.start}–${state.lines.end} · ${count}`
    : `file history · ${count}`;
}
