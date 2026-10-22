import { describe, expect, it } from 'vitest';
import type { CommitEntry } from '../src/git/parsers';
import { historyDescription, previousVersion, step, type HistoryEntry, type HistoryState } from '../src/history/historyModel';

const commit = (sha: string, parents: string[] = [`${sha}-parent`]): CommitEntry => ({ sha, parents, author: 'a', authoredAt: 1, subject: sha });
const entry = (sha: string, path = 'src/new.ts', status = 'M', parents?: string[]): HistoryEntry => ({ commit: commit(sha, parents), path, status });

function state(entries: HistoryEntry[], overrides: Partial<HistoryState> = {}): HistoryState {
  return { mode: 'file', root: '/r', path: 'src/new.ts', entries, truncated: false, ...overrides };
}

describe('previousVersion', () => {
  const renamed = state([entry('c3'), entry('c2', 'src/new.ts', 'R'), entry('c1', 'src/old.ts', 'A', [])]);

  it('is the next older entry at its own path (follows renames)', () => {
    expect(previousVersion(renamed, 0)).toEqual({ kind: 'commit', sha: 'c2', path: 'src/new.ts' });
    expect(previousVersion(renamed, 1)).toEqual({ kind: 'commit', sha: 'c1', path: 'src/old.ts' });
  });

  it('is empty for the commit that created the file', () => {
    expect(previousVersion(renamed, 2)).toEqual({ kind: 'empty' });
  });

  it("falls back to the parent when the list was cut off at the limit", () => {
    expect(previousVersion(state([entry('c9')], { truncated: true }), 0)).toEqual({ kind: 'commit', sha: 'c9-parent', path: 'src/new.ts' });
    expect(previousVersion(state([entry('c9')]), 0)).toEqual({ kind: 'empty' });
  });

  it('uses the first parent at today\'s path in lines mode', () => {
    const lines = state([entry('c3'), entry('c2')], { mode: 'lines', lines: { start: 1, end: 2 } });
    expect(previousVersion(lines, 0)).toEqual({ kind: 'commit', sha: 'c3-parent', path: 'src/new.ts' });
    expect(previousVersion(state([entry('root', 'src/new.ts', 'M', [])], { mode: 'lines' }), 0)).toEqual({ kind: 'empty' });
  });
});

describe('step', () => {
  it('from a plain editor: shows uncommitted changes first, otherwise the newest commit', () => {
    expect(step({ kind: 'working', inDiff: false, uncommitted: true }, 'previous', 3)).toEqual({ kind: 'open', right: 'working' });
    expect(step({ kind: 'working', inDiff: false, uncommitted: false }, 'previous', 3)).toEqual({ kind: 'open', right: 0 });
    expect(step({ kind: 'working', inDiff: true, uncommitted: true }, 'previous', 3)).toEqual({ kind: 'open', right: 0 });
  });

  it('moves the right side one version back or forward, ending at the working file', () => {
    expect(step({ kind: 'commit', index: 0 }, 'previous', 3)).toEqual({ kind: 'open', right: 1 });
    expect(step({ kind: 'commit', index: 1 }, 'next', 3)).toEqual({ kind: 'open', right: 0 });
    expect(step({ kind: 'commit', index: 0 }, 'next', 3)).toEqual({ kind: 'open', right: 'working' });
  });

  it('says so at either end, or when there is no history', () => {
    expect(step({ kind: 'commit', index: 2 }, 'previous', 3)).toMatchObject({ kind: 'message', text: expect.stringContaining('oldest') });
    expect(step({ kind: 'working', inDiff: true, uncommitted: false }, 'next', 3)).toMatchObject({ kind: 'message', text: expect.stringContaining('newest') });
    expect(step({ kind: 'working', inDiff: false, uncommitted: false }, 'previous', 0)).toMatchObject({ kind: 'message' });
  });
});

describe('historyDescription', () => {
  it('names the mode and the count', () => {
    expect(historyDescription(state([entry('a'), entry('b')]))).toBe('file history · 2 commits');
    expect(historyDescription(state([entry('a')]))).toBe('file history · 1 commit');
    expect(historyDescription(state([entry('a')], { truncated: true }))).toBe('file history · 1+ commits');
    expect(historyDescription(state([entry('a')], { mode: 'lines', lines: { start: 12, end: 20 } }))).toBe('lines 12–20 · 1 commit');
  });
});
