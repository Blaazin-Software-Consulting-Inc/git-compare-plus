import { describe, expect, it } from 'vitest';
import { attachOrigins, originMark, originTooltip, touchedPaths, uncommittedFileCount } from '../src/changeOrigin';
import type { ChangedFile, UncommittedState } from '../src/git/parsers';

const file = (p: string, status: ChangedFile['status'] = 'modified', oldPath = p): ChangedFile => ({ status, path: p, oldPath });
const unstaged: UncommittedState = { staged: false, unstaged: true, untracked: false };
const staged: UncommittedState = { staged: true, unstaged: false, untracked: false };
const untracked: UncommittedState = { staged: false, unstaged: false, untracked: true };

describe('attachOrigins', () => {
  it('marks committed, uncommitted and both, keeping order and other fields', () => {
    const files = [{ ...file('both.ts'), lines: { added: 1, deleted: 0, binary: false } }, file('committed.ts'), file('edited.ts')];
    const result = attachOrigins(files, new Set(['both.ts', 'committed.ts']), new Map([['both.ts', unstaged], ['edited.ts', staged]]));
    expect(result.map((f) => [f.path, f.origin])).toEqual([
      ['both.ts', { committed: true, uncommitted: unstaged }],
      ['committed.ts', { committed: true }],
      ['edited.ts', { committed: false, uncommitted: staged }],
    ]);
    expect(result[0]?.lines).toEqual({ added: 1, deleted: 0, binary: false });
  });

  it('finds a renamed file under its old path on either side', () => {
    // Committed under the old name, then renamed with `git mv` (uncommitted, staged).
    const renamed = file('new.ts', 'renamed', 'old.ts');
    expect(attachOrigins([renamed], new Set(['old.ts']), new Map([['new.ts', staged]]))[0]?.origin).toEqual({ committed: true, uncommitted: staged });
    // Renamed in a commit, then edited: status knows the new name only.
    expect(attachOrigins([renamed], new Set(['old.ts', 'new.ts']), new Map())[0]?.origin).toEqual({ committed: true });
    // An uncommitted rename only: status keys the original path too.
    expect(attachOrigins([renamed], new Set(), new Map([['old.ts', staged]]))[0]?.origin).toEqual({ committed: false, uncommitted: staged });
  });

  it('leaves a file in neither list unmarked (disk changed between git calls)', () => {
    const lone = file('lone.ts');
    expect(attachOrigins([lone], new Set(), new Map())[0]).toBe(lone);
  });

  it('handles an empty comparison', () => {
    expect(attachOrigins([], new Set(['a']), new Map([['a', unstaged]]))).toEqual([]);
  });
});

describe('touchedPaths', () => {
  it('collects new and old paths', () => {
    expect([...touchedPaths([file('a.ts'), file('b.ts', 'renamed', 'old-b.ts')])].sort()).toEqual(['a.ts', 'b.ts', 'old-b.ts']);
    expect(touchedPaths([]).size).toBe(0);
  });
});

describe('originMark and originTooltip', () => {
  it('marks only files with uncommitted edits', () => {
    expect(originMark({ committed: false, uncommitted: untracked })).toBe('✎');
    expect(originMark({ committed: true, uncommitted: unstaged })).toBe('✎');
    expect(originMark({ committed: true })).toBe('');
    expect(originMark(undefined)).toBe('');
  });

  it('says committed, uncommitted only or both, and which kind of edit', () => {
    expect(originTooltip({ committed: true })).toBe('Committed: no uncommitted edits.');
    expect(originTooltip({ committed: true, uncommitted: { staged: true, unstaged: true, untracked: false } })).toBe('✎ Committed, plus uncommitted edits (staged and not staged).');
    expect(originTooltip({ committed: false, uncommitted: unstaged })).toBe('✎ Uncommitted only (not staged): not in any commit yet.');
    expect(originTooltip({ committed: false, uncommitted: untracked })).toBe('✎ Uncommitted only (untracked): not in any commit yet.');
    expect(originTooltip(undefined)).toBeUndefined();
  });
});

describe('uncommittedFileCount', () => {
  it('counts files with uncommitted edits only', () => {
    const files = attachOrigins([file('a'), file('b'), file('c'), file('d')], new Set(['a', 'b']), new Map([['b', unstaged], ['c', untracked]]));
    expect(uncommittedFileCount(files)).toBe(2);
    expect(uncommittedFileCount([])).toBe(0);
  });
});
