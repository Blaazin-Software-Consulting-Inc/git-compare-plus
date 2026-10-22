import { describe, expect, it } from 'vitest';
import {
  countStatusEntries,
  lineStatsOfContent,
  parseAheadBehindRefs,
  parseBlameIncremental,
  parseCommitLog,
  parseFileHistory,
  parseCommitDates,
  parseNameStatusZ,
  parseLeftRightCount,
  parseLsTreeZ,
  parseNulList,
  parseNumstatZ,
  parseRefList,
  parseTagList,
  parseWorktreeList,
} from '../src/git/parsers';

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

describe('commit dates', () => {
  it('parseRefList reads the committer date (seconds → ms)', () => {
    const line = ['refs/heads/feat', 'feat', 'abc', '', ' ', '1791819983'].join('\0');
    expect(parseRefList(line)[0]?.committedAt).toBe(1_791_819_983_000);
  });

  it('parseRefList leaves the date undefined when missing or malformed', () => {
    expect(parseRefList(['refs/heads/x', 'x', 'a', '', ' ', 'nope'].join('\0'))[0]?.committedAt).toBeUndefined();
  });

  it('parseCommitDates maps SHA → ms and skips junk lines', () => {
    expect(parseCommitDates('aaa 100\nbbb 200\n\ngarbage\n')).toEqual(
      new Map([
        ['aaa', 100_000],
        ['bbb', 200_000],
      ]),
    );
  });
});

describe('parseNumstatZ', () => {
  it('parses counts, binary files, and keys renames by the NEW path', () => {
    const out = ['12\t3\tsrc/a.ts', '-\t-\timg.png', '0\t0\t', 'old.ts', 'new.ts', '5\t0\tb.ts', ''].join('\0');
    expect([...parseNumstatZ(out)]).toEqual([
      ['src/a.ts', { added: 12, deleted: 3, binary: false }],
      ['img.png', { added: 0, deleted: 0, binary: true }],
      ['new.ts', { added: 0, deleted: 0, binary: false }],
      ['b.ts', { added: 5, deleted: 0, binary: false }],
    ]);
  });

  it('keeps tabs inside a path (splits on the first two tabs only)', () => {
    expect(parseNumstatZ('1\t2\tdir\twith tab.ts\0').get('dir\twith tab.ts')).toEqual({ added: 1, deleted: 2, binary: false });
  });

  it('stops at a truncated rename record instead of misaligning', () => {
    expect([...parseNumstatZ('1\t1\ta.ts\0' + '2\t2\t\0only-old').keys()]).toEqual(['a.ts']);
  });

  it('returns an empty map for empty output', () => {
    expect(parseNumstatZ('').size).toBe(0);
  });
});

describe('lineStatsOfContent', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('counts newline-terminated lines', () => {
    expect(lineStatsOfContent(bytes('a\nb\n'))).toEqual({ added: 2, deleted: 0, binary: false });
  });

  it('counts a final line without a trailing newline, as git does', () => {
    expect(lineStatsOfContent(bytes('a\nb'))).toEqual({ added: 2, deleted: 0, binary: false });
  });

  it('is zero lines for an empty file', () => {
    expect(lineStatsOfContent(new Uint8Array())).toEqual({ added: 0, deleted: 0, binary: false });
  });

  it('treats a NUL byte in the first 8000 bytes as binary', () => {
    expect(lineStatsOfContent(new Uint8Array([0x61, 0x00, 0x0a]))).toEqual({ added: 0, deleted: 0, binary: true });
  });

  it('does not look past 8000 bytes for NUL (same probe size as git)', () => {
    const content = new Uint8Array(8001).fill(0x61);
    content[8000] = 0;
    expect(lineStatsOfContent(content).binary).toBe(false);
  });
});

describe('parseLsTreeZ', () => {
  it('maps path → object id, keeping spaces and tabs in paths', () => {
    const out = ['100644 blob aaa111\tsrc/a.ts', '120000 blob bbb222\tdir with space/link', '160000 commit ccc333\tsub\tmodule', ''].join('\0');
    expect([...parseLsTreeZ(out)]).toEqual([
      ['src/a.ts', 'aaa111'],
      ['dir with space/link', 'bbb222'],
      ['sub\tmodule', 'ccc333'],
    ]);
  });

  it('skips malformed records and empty output', () => {
    expect(parseLsTreeZ('garbage\0').size).toBe(0);
    expect(parseLsTreeZ('').size).toBe(0);
  });
});

describe('parseAheadBehindRefs', () => {
  it('maps short names to counts and drops <remote>/HEAD', () => {
    const out = [
      ['refs/heads/feature/x', 'feature/x', '3 12'].join('\0'),
      ['refs/remotes/origin/HEAD', 'origin', '0 0'].join('\0'),
      ['refs/remotes/origin/main', 'origin/main', '0 0'].join('\0'),
      '',
    ].join('\n');
    expect([...parseAheadBehindRefs(out)]).toEqual([
      ['feature/x', { ahead: 3, behind: 12 }],
      ['origin/main', { ahead: 0, behind: 0 }],
    ]);
  });

  it('skips records with missing or non-numeric counts', () => {
    expect(parseAheadBehindRefs(['refs/heads/a', 'a', ''].join('\0') + '\n' + ['refs/heads/b', 'b', 'x y'].join('\0')).size).toBe(0);
  });
});

describe('parseLeftRightCount', () => {
  it('reads <behind>\\t<ahead>', () => {
    expect(parseLeftRightCount('12\t3\n')).toEqual({ ahead: 3, behind: 12 });
  });

  it('is undefined for malformed output', () => {
    expect(parseLeftRightCount('')).toBeUndefined();
    expect(parseLeftRightCount('nope')).toBeUndefined();
  });
});

describe('parseCommitLog', () => {
  const record = (...fields: string[]) => fields.join('\x1f');

  it('parses NUL-terminated records with parents, author, date and subject', () => {
    const out = [
      record('aaa', 'p1', 'Ada Lovelace', '1700000000', 'Add engine'),
      record('bbb', 'p1 p2', 'Grace', '1700000100', "Merge branch 'x'"),
      record('ccc', '', 'Root', '1600000000', ''),
      '',
    ].join('\0');
    expect(parseCommitLog(out)).toEqual([
      { sha: 'aaa', parents: ['p1'], author: 'Ada Lovelace', authoredAt: 1_700_000_000_000, subject: 'Add engine' },
      { sha: 'bbb', parents: ['p1', 'p2'], author: 'Grace', authoredAt: 1_700_000_100_000, subject: "Merge branch 'x'" },
      { sha: 'ccc', parents: [], author: 'Root', authoredAt: 1_600_000_000_000, subject: '' },
    ]);
  });

  it('skips malformed records and returns nothing for empty output', () => {
    expect(parseCommitLog(record('aaa', 'p', 'a', 'not-a-date', 's'))).toEqual([]);
    expect(parseCommitLog('')).toEqual([]);
  });
});

describe('parseTagList', () => {
  it('parses names with dates and tolerates a missing date', () => {
    expect(parseTagList(['v1\x001700000000', 'v0\x00', ''].join('\n'))).toEqual([
      { name: 'v1', createdAt: 1_700_000_000_000 },
      { name: 'v0', createdAt: undefined },
    ]);
  });
});

describe('parseBlameIncremental', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const ZERO = '0'.repeat(40);
  const out = [
    `${A} 1 1 2`,
    'author Ada Lovelace',
    'author-time 1700000000',
    'summary Add engine',
    'boundary',
    'filename src/engine.ts',
    `${ZERO} 3 3 1`,
    'author External file (--contents)',
    'author-time 1800000000',
    'summary Version of src/engine.ts from standard input',
    `previous ${B} src/engine.ts`,
    'filename src/engine.ts',
    `${B} 2 4 1`,
    'author Grace',
    'author-time 1750000000',
    'summary Rename the engine',
    `previous ${A} src/old engine.ts`,
    'filename src/old engine.ts',
    // A later group for a commit already seen repeats only the group line and filename.
    `${A} 3 5 1`,
    'filename src/engine.ts',
    '',
  ].join('\n');

  it('assigns every final line its commit, path at that commit, and original line', () => {
    const lines = parseBlameIncremental(out);
    expect(lines.map((l) => l.commit.sha[0])).toEqual(['a', 'a', '0', 'b', 'a']);
    expect(lines[0]).toMatchObject({ path: 'src/engine.ts', originalLine: 1, commit: { author: 'Ada Lovelace', authoredAt: 1_700_000_000_000, summary: 'Add engine', uncommitted: false } });
    expect(lines[1]?.originalLine).toBe(2);
    expect(lines[4]).toMatchObject({ originalLine: 3, commit: { author: 'Ada Lovelace', summary: 'Add engine' } });
  });

  it('marks uncommitted lines and keeps the previous commit and path (renames)', () => {
    const lines = parseBlameIncremental(out);
    expect(lines[2]?.commit.uncommitted).toBe(true);
    expect(lines[3]).toMatchObject({ path: 'src/old engine.ts', commit: { previous: { sha: A, path: 'src/old engine.ts' } } });
    expect(lines[0]?.commit.previous).toBeUndefined();
  });

  it('returns nothing for empty output', () => {
    expect(parseBlameIncremental('')).toEqual([]);
  });
});

describe('parseFileHistory', () => {
  const record = (sha: string, subject: string) => [sha, 'p', 'A', '1700000000', subject].join('\x1f');

  it('reads each commit with its status and the path in that commit, following a rename', () => {
    const out = [
      record('c3', 'edit'), '\nM', 'src/new.ts',
      record('c2', 'rename'), '\nR100', 'src/old.ts', 'src/new.ts',
      record('c1', 'add'), '\nA', 'src/old.ts',
      '',
    ].join('\0');
    expect(parseFileHistory(out, 'src/new.ts').map((e) => [e.commit.sha, e.status, e.path])).toEqual([
      ['c3', 'M', 'src/new.ts'],
      ['c2', 'R', 'src/new.ts'],
      ['c1', 'A', 'src/old.ts'],
    ]);
  });

  it('keeps the newer path for a commit that reports no change (some merges)', () => {
    const out = [record('m', 'merge'), record('c1', 'edit'), '\nM', 'a.ts', ''].join('\0');
    expect(parseFileHistory(out, 'a.ts').map((e) => [e.commit.sha, e.path])).toEqual([
      ['m', 'a.ts'],
      ['c1', 'a.ts'],
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseFileHistory('', 'a.ts')).toEqual([]);
  });
});
