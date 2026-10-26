import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  COMMIT_LIMIT,
  baseForcesDirect,
  diffSides,
  runComparisons,
  subjectCwd,
  totalLineStats,
  type BaseSpec,
  type ComparisonResult,
  type Subject,
} from '../src/comparison';
import { fakePort, recordingLogger, repo } from './helpers';

const options = (includeUntracked = true) => ({ includeUntracked, logger: recordingLogger() });
const worktree = (root: string, includeUncommitted = true, label = 'feature'): Subject => ({ kind: 'worktree', root, label, includeUncommitted });
const branch = (ref: string): Subject => ({ kind: 'ref', ref, label: ref });
const DEFAULT: BaseSpec = { kind: 'default' };

describe('subject: worktree including uncommitted edits', () => {
  it('diffs the WORKING TREE against merge-base(base, HEAD) and lists untracked files', async () => {
    const git = fakePort({
      mergeBase: vi.fn(async () => 'mb1'),
      diffNameStatus: vi.fn(async () => [
        { status: 'modified' as const, path: 'z.ts', oldPath: 'z.ts' },
        { status: 'added' as const, path: 'intent.ts', oldPath: 'intent.ts' },
      ]),
      untracked: vi.fn(async () => ['new.ts', 'intent.ts']),
    });
    const wt = '/ws/svc/.claude/worktrees/x';

    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree(wt) }], { kind: 'ref', ref: 'origin/main' }, 'merge-base', options());

    expect(git.mergeBase).toHaveBeenCalledWith(wt, 'origin/main', 'HEAD');
    expect(git.diffNameStatus).toHaveBeenCalledWith(wt, 'mb1');
    expect(git.uncommittedCount).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'compared', mode: 'merge-base', baseLabel: 'origin/main', baseRevision: 'mb1', subjectRevision: undefined });
    expect(result?.files.map((f) => [f.status, f.path])).toEqual([
      ['added', 'intent.ts'],
      ['untracked', 'new.ts'],
      ['modified', 'z.ts'],
    ]);
  });

  it('skips untracked files when the setting is off', async () => {
    const git = fakePort();
    await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/ws/svc') }], DEFAULT, 'merge-base', options(false));
    expect(git.untracked).not.toHaveBeenCalled();
  });
});

describe('subject: worktree, committed only', () => {
  it("diffs against the worktree's HEAD commit and reports how many uncommitted files are left out", async () => {
    const git = fakePort({ uncommittedCount: vi.fn(async () => 3) });

    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt', false) }], DEFAULT, 'merge-base', options());

    expect(git.resolveCommit).toHaveBeenCalledWith('/wt', 'HEAD');
    expect(git.diffNameStatus).toHaveBeenCalledWith('/wt', 'mb', 'sha:HEAD');
    expect(git.untracked).not.toHaveBeenCalled();
    expect(result).toMatchObject({ subjectRevision: 'sha:HEAD', excludedUncommitted: { subject: 3 } });
  });
});

describe('subject: branch', () => {
  it('diffs merge-base(base, branch) against the branch tip, from the main worktree', async () => {
    const git = fakePort();

    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature/y') }], DEFAULT, 'merge-base', options());

    expect(git.mergeBase).toHaveBeenCalledWith('/ws/svc', 'origin/master', 'feature/y');
    expect(git.diffNameStatus).toHaveBeenCalledWith('/ws/svc', 'mb', 'sha:feature/y');
    expect(result?.excludedUncommitted).toEqual({ subject: undefined, base: undefined });
  });

  it('fails clearly when the branch no longer exists', async () => {
    const git = fakePort({ resolveCommit: vi.fn(async () => undefined) });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('gone') }], DEFAULT, 'merge-base', options());
    expect(result).toMatchObject({ outcome: 'failed', errorMessage: 'gone no longer exists' });
  });
});

describe('base: worktree', () => {
  it('committed only: uses its HEAD commit, keeps the requested mode, counts its uncommitted files', async () => {
    const git = fakePort({ uncommittedCount: vi.fn(async (root: string) => (root === '/other' ? 2 : 0)) });
    const base: BaseSpec = { kind: 'worktree', root: '/other', label: 'other', includeUncommitted: false };

    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt') }], base, 'merge-base', options());

    expect(git.resolveCommit).toHaveBeenCalledWith('/other', 'HEAD');
    expect(git.mergeBase).toHaveBeenCalledWith('/wt', 'sha:HEAD', 'HEAD');
    expect(result).toMatchObject({ mode: 'merge-base', baseLabel: 'other', excludedUncommitted: { base: 2 } });
  });

  it('including uncommitted: diffs against a snapshot tree and forces direct mode', async () => {
    const git = fakePort();
    const base: BaseSpec = { kind: 'worktree', root: '/other', label: 'other', includeUncommitted: true };

    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt') }], base, 'merge-base', options(false));

    expect(git.snapshotWorktree).toHaveBeenCalledWith('/other', false);
    expect(git.mergeBase).not.toHaveBeenCalled();
    expect(git.diffNameStatus).toHaveBeenCalledWith('/wt', 'tree:/other');
    expect(result).toMatchObject({ mode: 'direct', baseRevision: 'tree:/other' });
  });
});

describe('mode: direct', () => {
  it('uses the base commit itself instead of the merge base', async () => {
    const git = fakePort();

    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feat') }], { kind: 'ref', ref: 'origin/main' }, 'direct', options());

    expect(git.mergeBase).not.toHaveBeenCalled();
    expect(git.resolveCommit).toHaveBeenCalledWith('/ws/svc', 'origin/main');
    expect(result).toMatchObject({ mode: 'direct', baseRevision: 'sha:origin/main' });
  });

  it('marks ref_missing when the base does not resolve', async () => {
    const git = fakePort({ resolveCommit: vi.fn(async (_cwd: string, rev: string) => (rev === 'nope' ? undefined : `sha:${rev}`)) });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feat') }], { kind: 'ref', ref: 'nope' }, 'direct', options());
    expect(result?.outcome).toBe('ref_missing');
  });
});

describe('base resolution and failures', () => {
  it('resolves the default branch per repo (master in one, main in another)', async () => {
    const git = fakePort({ defaultBranch: vi.fn(async (cwd: string) => (cwd.endsWith('lib') ? 'origin/main' : 'origin/master')) });

    const results = await runComparisons(
      git,
      [
        { repo: repo('svc'), subject: worktree('/ws/svc') },
        { repo: repo('lib'), subject: worktree('/ws/lib') },
      ],
      DEFAULT,
      'merge-base',
      options(),
    );

    expect(results.map((r) => r.baseLabel)).toEqual(['origin/master', 'origin/main']);
  });

  it('marks ref_missing and logs WARN when no default branch exists', async () => {
    const opts = options();
    const git = fakePort({ defaultBranch: vi.fn(async () => undefined) });

    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/ws/svc') }], DEFAULT, 'merge-base', opts);

    expect(result).toMatchObject({ outcome: 'ref_missing', files: [] });
    expect(git.mergeBase).not.toHaveBeenCalled();
    expect(opts.logger.calls.warn).toHaveLength(1);
  });

  it('marks ref_missing when the base shares no history with the subject', async () => {
    const git = fakePort({ mergeBase: vi.fn(async () => undefined) });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('x') }], { kind: 'ref', ref: 'other' }, 'merge-base', options());
    expect(result).toMatchObject({ outcome: 'ref_missing', baseLabel: 'other' });
    expect(git.diffNameStatus).not.toHaveBeenCalled();
  });

  it('isolates a failing repo: ERROR with context, message kept, others still compared', async () => {
    const opts = options();
    const git = fakePort({
      diffNameStatus: vi.fn(async (cwd: string) => {
        if (cwd === '/ws/broken') {
          throw new Error('bad object');
        }
        return [];
      }),
    });

    const results = await runComparisons(
      git,
      [
        { repo: repo('broken'), subject: worktree('/ws/broken') },
        { repo: repo('ok'), subject: worktree('/ws/ok') },
      ],
      DEFAULT,
      'merge-base',
      opts,
    );

    expect(results.map((r) => r.outcome)).toEqual(['failed', 'compared']);
    expect(results[0]).toMatchObject({ errorMessage: 'bad object', baseLabel: 'origin/master', baseRevision: 'mb' });
    const [message, , fields] = opts.logger.calls.error[0] ?? [];
    expect(message).toBe('comparison failed');
    expect(fields).toMatchObject({ repo: 'broken', progress: { baseLabel: 'origin/master', baseRevision: 'mb' } });
  });

  it('logs start and finish at INFO; empty request list returns empty', async () => {
    const opts = options();
    await runComparisons(fakePort(), [{ repo: repo('a'), subject: worktree('/ws/a') }], DEFAULT, 'merge-base', opts);
    expect(opts.logger.calls.info.map(([m]) => m)).toEqual(['comparison started', 'comparison finished']);
    expect(await runComparisons(fakePort(), [], DEFAULT, 'merge-base', options())).toEqual([]);
  });
});

describe('line stats', () => {
  const modified = { status: 'modified' as const, path: 'a.ts', oldPath: 'a.ts' };
  const stats = (added: number, deleted: number) => ({ added, deleted, binary: false });

  it('numstats the same two sides as the file list and attaches counts by path', async () => {
    const git = fakePort({
      diffNameStatus: vi.fn(async () => [modified]),
      diffNumstat: vi.fn(async () => new Map([['a.ts', stats(4, 2)]])),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature/y') }], DEFAULT, 'merge-base', options());
    expect(git.diffNumstat).toHaveBeenCalledWith('/ws/svc', 'mb', 'sha:feature/y');
    expect(result?.files[0]?.lines).toEqual(stats(4, 2));
  });

  it('counts untracked files from disk, only for the untracked ones, against the working tree', async () => {
    const git = fakePort({
      diffNameStatus: vi.fn(async () => [modified]),
      untracked: vi.fn(async () => ['new.ts']),
      diffNumstat: vi.fn(async () => new Map([['a.ts', stats(1, 1)]])),
      untrackedLineStats: vi.fn(async () => new Map([['new.ts', stats(9, 0)]])),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt') }], DEFAULT, 'merge-base', options());
    expect(git.diffNumstat).toHaveBeenCalledWith('/wt', 'mb', undefined);
    expect(git.untrackedLineStats).toHaveBeenCalledWith('/wt', ['new.ts']);
    expect(result?.files.map((f) => [f.path, f.lines])).toEqual([
      ['a.ts', stats(1, 1)],
      ['new.ts', stats(9, 0)],
    ]);
  });

  it('does not read files from disk when nothing is untracked', async () => {
    const git = fakePort({ diffNameStatus: vi.fn(async () => [modified]) });
    await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt') }], DEFAULT, 'merge-base', options());
    expect(git.untrackedLineStats).not.toHaveBeenCalled();
  });

  it('still lists the files, without counts, when numstat fails (WARN, not a failed comparison)', async () => {
    const logger = recordingLogger();
    const git = fakePort({
      diffNameStatus: vi.fn(async () => [modified]),
      diffNumstat: vi.fn(async () => {
        throw new Error('timed out');
      }),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature/y') }], DEFAULT, 'merge-base', { includeUntracked: true, logger });
    expect(result?.outcome).toBe('compared');
    expect(result?.files).toEqual([modified]);
    expect(logger.calls.warn).toEqual([[expect.stringContaining('line stats unavailable'), expect.objectContaining({ operation: 'diffNumstat', reason: 'timed out' })]]);
  });

  it('still lists untracked files when reading them fails', async () => {
    const git = fakePort({
      untracked: vi.fn(async () => ['new.ts']),
      untrackedLineStats: vi.fn(async () => {
        throw new Error('EMFILE');
      }),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt') }], DEFAULT, 'merge-base', options());
    expect(result?.files).toEqual([{ status: 'untracked', path: 'new.ts', oldPath: 'new.ts' }]);
  });

  it('attaches fingerprints from the same two sides', async () => {
    const git = fakePort({
      diffNameStatus: vi.fn(async () => [modified]),
      blobIds: vi.fn(async (_cwd: string, revision: string) => new Map([['a.ts', revision === 'mb' ? 'L' : 'R']])),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature/y') }], DEFAULT, 'merge-base', options());
    expect(result?.files[0]?.fingerprint).toBe('L>R');
  });

  it('still lists the files, without fingerprints, when fingerprinting fails (WARN)', async () => {
    const logger = recordingLogger();
    const git = fakePort({
      diffNameStatus: vi.fn(async () => [modified]),
      hashWorkingFiles: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt') }], DEFAULT, 'merge-base', { includeUntracked: true, logger });
    expect(result?.outcome).toBe('compared');
    expect(result?.files).toEqual([modified]);
    expect(logger.calls.warn).toEqual([[expect.stringContaining('fingerprints unavailable'), expect.objectContaining({ reason: 'EACCES' })]]);
  });

  it('totals skip binary and unknown files', () => {
    expect(
      totalLineStats([
        { ...modified, lines: stats(3, 1) },
        { ...modified, path: 'b', lines: { added: 0, deleted: 0, binary: true } },
        { ...modified, path: 'c' },
        { ...modified, path: 'd', lines: stats(2, 5) },
      ]),
    ).toEqual({ added: 5, deleted: 6 });
    expect(totalLineStats([])).toEqual({ added: 0, deleted: 0 });
  });
});

describe('commits', () => {
  const commit = (sha: string) => ({ sha, parents: ['p'], author: 'a', authoredAt: 1, subject: sha });

  it('lists merge-base..branch tip for a branch, asking for one more than the limit', async () => {
    const git = fakePort({ commitsBetween: vi.fn(async () => [commit('c2'), commit('c1')]) });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature/y') }], DEFAULT, 'merge-base', options());
    expect(git.commitsBetween).toHaveBeenCalledWith('/ws/svc', 'mb', 'sha:feature/y', COMMIT_LIMIT + 1);
    expect(result?.commits).toEqual({ entries: [commit('c2'), commit('c1')], truncated: false });
  });

  it("uses the worktree's own HEAD when uncommitted edits are included, and the base commit in direct mode", async () => {
    const git = fakePort();
    await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/wt') }], DEFAULT, 'direct', options());
    expect(git.commitsBetween).toHaveBeenCalledWith('/wt', 'sha:origin/master', 'HEAD', COMMIT_LIMIT + 1);
  });

  it('marks the list truncated past the limit and keeps only the newest COMMIT_LIMIT', async () => {
    const many = Array.from({ length: COMMIT_LIMIT + 1 }, (_, i) => commit(`c${i}`));
    const git = fakePort({ commitsBetween: vi.fn(async () => many) });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('x') }], DEFAULT, 'merge-base', options());
    expect(result?.commits?.truncated).toBe(true);
    expect(result?.commits?.entries).toHaveLength(COMMIT_LIMIT);
    expect(result?.commits?.entries[0]?.sha).toBe('c0');
  });

  it('has no commit list when the base is a snapshot (a tree has no history)', async () => {
    const git = fakePort();
    const base: BaseSpec = { kind: 'worktree', root: '/ws/svc', label: 'main', includeUncommitted: true };
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('x') }], base, 'direct', options());
    expect(git.commitsBetween).not.toHaveBeenCalled();
    expect(result?.commits).toBeUndefined();
  });

  it('still compares when listing commits fails (WARN, no list)', async () => {
    const logger = recordingLogger();
    const git = fakePort({
      commitsBetween: vi.fn(async () => {
        throw new Error('shallow clone');
      }),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('x') }], DEFAULT, 'merge-base', { includeUntracked: true, logger });
    expect(result).toMatchObject({ outcome: 'compared', commits: undefined });
    expect(logger.calls.warn).toEqual([[expect.stringContaining('commit list unavailable'), expect.objectContaining({ reason: 'shallow clone' })]]);
  });
});

describe('baseForcesDirect', () => {
  it('is true only for a worktree base that includes uncommitted edits', () => {
    expect(baseForcesDirect({ kind: 'worktree', root: '/w', label: 'w', includeUncommitted: true })).toBe(true);
    expect(baseForcesDirect({ kind: 'worktree', root: '/w', label: 'w', includeUncommitted: false })).toBe(false);
    expect(baseForcesDirect({ kind: 'ref', ref: 'main' })).toBe(false);
    expect(baseForcesDirect(DEFAULT)).toBe(false);
  });
});

describe('subjectCwd', () => {
  it('runs git in the worktree for a worktree subject and in the main worktree for a branch', () => {
    expect(subjectCwd({ repo: repo('svc'), subject: worktree('/elsewhere/wt') })).toBe('/elsewhere/wt');
    expect(subjectCwd({ repo: repo('svc'), subject: branch('b') })).toBe('/ws/svc');
  });
});

describe('diffSides', () => {
  const compared = (subject: Subject, subjectRevision?: string): ComparisonResult => ({
    repo: repo('svc'),
    subject,
    outcome: 'compared',
    mode: 'merge-base',
    baseLabel: 'origin/master',
    baseRevision: 'mb',
    subjectRevision,
    excludedUncommitted: {},
    files: [],
  });

  it('working tree: base revision vs the live file on disk', () => {
    expect(diffSides(compared(worktree('/wt')), { status: 'modified', path: 'src/a.ts', oldPath: 'src/a.ts' })).toEqual({
      left: { kind: 'revision', cwd: '/wt', revision: 'mb', path: 'src/a.ts' },
      // The file on disk, in the platform's own form (backslashes on Windows).
      right: { kind: 'file', absolutePath: path.join('/wt', 'src', 'a.ts') },
    });
  });

  it('committed-only worktree or branch: right side reads the subject revision', () => {
    expect(diffSides(compared(worktree('/wt', false), 'abc'), { status: 'modified', path: 'a.ts', oldPath: 'a.ts' }).right).toEqual({
      kind: 'revision',
      cwd: '/wt',
      revision: 'abc',
      path: 'a.ts',
    });
    expect(diffSides(compared(branch('feat'), 'def'), { status: 'modified', path: 'a.ts', oldPath: 'a.ts' }).right).toEqual({
      kind: 'revision',
      cwd: '/ws/svc',
      revision: 'def',
      path: 'a.ts',
    });
  });

  it('rename: left reads the OLD path', () => {
    expect(diffSides(compared(worktree('/wt')), { status: 'renamed', path: 'new.ts', oldPath: 'old.ts' }).left).toEqual({
      kind: 'revision',
      cwd: '/wt',
      revision: 'mb',
      path: 'old.ts',
    });
  });

  it.each(['added', 'untracked'] as const)('%s: empty left side', (status) => {
    expect(diffSides(compared(worktree('/wt')), { status, path: 'n.ts', oldPath: 'n.ts' }).left).toEqual({ kind: 'empty' });
  });

  it('deleted: empty right side', () => {
    expect(diffSides(compared(worktree('/wt')), { status: 'deleted', path: 'g.ts', oldPath: 'g.ts' }).right).toEqual({ kind: 'empty' });
  });
});

describe('branch point (merge-base mode)', () => {
  const other: BaseSpec = { kind: 'worktree', root: '/ws/svc/.wt/b', label: 'feature-b', includeUncommitted: false };

  it("says when the branch point is the Against side's own tip", async () => {
    const git = fakePort({ mergeBase: vi.fn(async () => 'sha:origin/main') });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature') }], { kind: 'ref', ref: 'origin/main' }, 'merge-base', options());
    expect(result?.branchPoint).toEqual({ isAgainstTip: true });
  });

  it('names the default branch when two worktrees split off it and the Against worktree moved on', async () => {
    const git = fakePort({
      mergeBase: vi.fn(async () => 'mb'),
      resolveCommit: vi.fn(async (cwd: string, revision: string) => (cwd === '/ws/svc/.wt/b' ? 'sha:b-head' : `sha:${revision}`)),
      isAncestor: vi.fn(async () => true),
    });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: worktree('/ws/svc/.wt/a') }], other, 'merge-base', options());
    expect(git.isAncestor).toHaveBeenCalledWith('/ws/svc/.wt/a', 'mb', 'origin/master');
    expect(result?.branchPoint).toEqual({ isAgainstTip: false, onDefaultBranch: 'origin/master' });
  });

  it('does not name the default branch when the branch point is not on it', async () => {
    const git = fakePort({ isAncestor: vi.fn(async () => false) });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature') }], { kind: 'ref', ref: 'develop' }, 'merge-base', options());
    expect(result?.branchPoint).toEqual({ isAgainstTip: false, onDefaultBranch: undefined });
  });

  it('does not check the default branch when it is the Against side', async () => {
    const git = fakePort();
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature') }], DEFAULT, 'merge-base', options());
    expect(git.isAncestor).not.toHaveBeenCalled();
    expect(result?.branchPoint).toEqual({ isAgainstTip: false, onDefaultBranch: undefined });
  });

  it('is absent in all-differences mode and for a snapshot Against', async () => {
    const git = fakePort();
    const [direct] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature') }], other, 'direct', options());
    const [snapshot] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature') }], { ...other, includeUncommitted: true }, 'merge-base', options());
    expect(direct?.branchPoint).toBeUndefined();
    expect(snapshot?.branchPoint).toBeUndefined();
    expect(git.isAncestor).not.toHaveBeenCalled();
  });

  it('still compares when it cannot be worked out, with a WARN', async () => {
    const logger = recordingLogger();
    const git = fakePort({ isAncestor: vi.fn(async () => Promise.reject(new Error('boom'))) });
    const [result] = await runComparisons(git, [{ repo: repo('svc'), subject: branch('feature') }], { kind: 'ref', ref: 'develop' }, 'merge-base', { includeUntracked: true, logger });
    expect(result?.outcome).toBe('compared');
    expect(result?.branchPoint).toBeUndefined();
    expect(logger.calls.warn.some(([message]) => message === 'branch point unavailable')).toBe(true);
  });
});
