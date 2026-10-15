import { describe, expect, it } from 'vitest';
import { countStatusEntries, parseNameStatusZ, parseNulList, parseRefList, parseWorktreeList } from '../src/git/parsers';

describe('parseNameStatusZ', () => {
  it('parses each status, including rename and copy pairs', () => {
    const out = ['M', 'src/a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R087', 'old.ts', 'new.ts', 'C100', 'src.ts', 'copy.ts', 'T', 'link', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'modified', path: 'src/a.ts', oldPath: 'src/a.ts' },
      { status: 'added', path: 'b.ts', oldPath: 'b.ts' },
      { status: 'deleted', path: 'c.ts', oldPath: 'c.ts' },
      { status: 'renamed', path: 'new.ts', oldPath: 'old.ts' },
      { status: 'added', path: 'copy.ts', oldPath: 'copy.ts' },
      { status: 'modified', path: 'link', oldPath: 'link' },
    ]);
  });

  it('keeps paths with spaces and newlines intact (NUL-separated)', () => {
    expect(parseNameStatusZ('M\0dir with space/a\nb.ts\0')).toEqual([
      { status: 'modified', path: 'dir with space/a\nb.ts', oldPath: 'dir with space/a\nb.ts' },
    ]);
  });

  it('drops unknown status letters but keeps parsing', () => {
    expect(parseNameStatusZ('X\0weird\0M\0ok.ts\0').map((f) => f.path)).toEqual(['ok.ts']);
  });

  it('stops at a truncated record instead of misaligning', () => {
    expect(parseNameStatusZ('M\0a.ts\0R100\0only-old')).toEqual([{ status: 'modified', path: 'a.ts', oldPath: 'a.ts' }]);
  });

  it('returns nothing for empty output', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });
});

describe('parseNulList', () => {
  it('splits and drops the trailing empty entry', () => {
    expect(parseNulList('a.ts\0b c.ts\0')).toEqual(['a.ts', 'b c.ts']);
    expect(parseNulList('')).toEqual([]);
  });
});

describe('parseWorktreeList', () => {
  it('parses main, linked, detached and prunable worktrees', () => {
    const out = [
      'worktree /repo',
      'HEAD aaaa',
      'branch refs/heads/master',
      '',
      'worktree /repo/.claude/worktrees/feat',
      'HEAD bbbb',
      'branch refs/heads/claude/feat',
      '',
      'worktree /tmp/detached',
      'HEAD cccc',
      'detached',
      '',
      'worktree /gone',
      'HEAD dddd',
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    expect(parseWorktreeList(out)).toEqual([
      { path: '/repo', head: 'aaaa', branch: 'master', detached: false, bare: false, prunable: false },
      { path: '/repo/.claude/worktrees/feat', head: 'bbbb', branch: 'claude/feat', detached: false, bare: false, prunable: false },
      { path: '/tmp/detached', head: 'cccc', detached: true, bare: false, prunable: false },
      { path: '/gone', head: 'dddd', branch: 'old', detached: false, bare: false, prunable: true },
    ]);
  });

  it('parses a bare main entry and ignores lines before the first worktree', () => {
    expect(parseWorktreeList('HEAD stray\nworktree /bare.git\nbare\n')).toEqual([
      { path: '/bare.git', detached: false, bare: true, prunable: false },
    ]);
  });
});

describe('parseRefList', () => {
  it('parses local and remote branches, upstream and HEAD marker; drops */HEAD and tags', () => {
    const lines = [
      ['refs/heads/master', 'master', 'aaa', 'origin/master', '*'],
      ['refs/heads/feat', 'feat', 'bbb', '', ' '],
      ['refs/remotes/origin/HEAD', 'origin', 'aaa', '', ' '],
      ['refs/remotes/origin/master', 'origin/master', 'aaa', '', ' '],
      ['refs/tags/v1', 'v1', 'ccc', '', ' '],
    ].map((fields) => fields.join('\0'));
    expect(parseRefList(lines.join('\n') + '\n')).toEqual([
      { name: 'master', kind: 'local', sha: 'aaa', upstream: 'origin/master', isHead: true },
      { name: 'feat', kind: 'local', sha: 'bbb', upstream: undefined, isHead: false },
      { name: 'origin/master', kind: 'remote', sha: 'aaa', upstream: undefined, isHead: false },
    ]);
  });
});

describe('countStatusEntries', () => {
  it('counts one per path and skips the extra original-path token of renames/copies', () => {
    const out = [' M a.ts', 'M  b.ts', 'R  new.ts', 'old.ts', '?? untracked.ts', 'C  copy.ts', 'src.ts', ''].join('\0');
    expect(countStatusEntries(out)).toBe(5);
  });

  it('is zero for a clean worktree', () => {
    expect(countStatusEntries('')).toBe(0);
  });
});
