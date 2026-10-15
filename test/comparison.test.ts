import { describe, expect, it, vi } from 'vitest';
import {
  baseForcesDirect,
  diffSides,
  runComparisons,
  subjectCwd,
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
      right: { kind: 'file', absolutePath: '/wt/src/a.ts' },
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
