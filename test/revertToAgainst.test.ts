import { describe, expect, it } from 'vitest';
import type { ComparisonResult, Subject } from '../src/comparison';
import type { ChangedFile, FileStatus } from '../src/git/parsers';
import { leftSideName, planRevert, revertConfirmation, revertUnavailableReason, type RevertPlan } from '../src/revertToAgainst';
import { repo } from './helpers';

const onDisk: Subject = { kind: 'worktree', root: '/wt', label: 'feature-x', includeUncommitted: true };

function result(overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return { repo: repo('svc'), subject: onDisk, outcome: 'compared', mode: 'direct', baseLabel: 'origin/main', baseRevision: 'abc1234def', excludedUncommitted: {}, files: [], ...overrides };
}

function file(status: FileStatus, filePath: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { status, path: filePath, oldPath: filePath, ...extra };
}

const uncommitted = { committed: false, uncommitted: { staged: false, unstaged: true, untracked: false } };

function plan(files: readonly ChangedFile[], overrides: Partial<ComparisonResult> = {}): RevertPlan {
  const planned = planRevert(result({ files, ...overrides }), files);
  if ('reason' in planned) {
    throw new Error(planned.reason);
  }
  return planned;
}

describe('revertUnavailableReason', () => {
  it('allows a worktree reviewed with its files on disk', () => {
    expect(revertUnavailableReason(result())).toBeUndefined();
  });

  it.each([
    ['a branch', { subject: { kind: 'ref', ref: 'feature', label: 'feature' } as Subject, subjectRevision: 'sha:feature' }],
    ['a committed-only worktree', { subject: { ...onDisk, includeUncommitted: false } as Subject, subjectRevision: 'sha:HEAD' }],
    ['a failed comparison', { outcome: 'failed' as const }],
    ['a comparison without a left side', { baseRevision: undefined }],
  ])('refuses %s', (_name, overrides) => {
    expect(revertUnavailableReason(result(overrides))).toEqual(expect.any(String));
  });
});

describe('planRevert', () => {
  it('restores modified and deleted files, trashes added and untracked ones', () => {
    const p = plan([file('modified', 'a.ts'), file('deleted', 'gone.ts'), file('added', 'new.ts'), file('untracked', 'scratch.txt')]);
    expect(p).toMatchObject({ root: '/wt', revision: 'abc1234def', restore: ['a.ts', 'gone.ts'], remove: ['new.ts', 'scratch.txt'], losesUncommitted: [] });
  });

  it('restores a rename at its old path and trashes the new one', () => {
    const p = plan([file('renamed', 'src/new-name.ts', { oldPath: 'src/old-name.ts' })]);
    expect(p.restore).toEqual(['src/old-name.ts']);
    expect(p.remove).toEqual(['src/new-name.ts']);
    expect(p.files).toHaveLength(1);
  });

  it('lists overwritten files whose uncommitted edits would be lost', () => {
    const p = plan([file('modified', 'edited.ts', { origin: uncommitted }), file('modified', 'committed.ts', { origin: { committed: true } })]);
    expect(p.losesUncommitted).toEqual(['edited.ts']);
  });

  it('does not count trashed or deleted files as losing edits: nothing on disk is overwritten', () => {
    const untrackedOrigin = { committed: false, uncommitted: { staged: false, unstaged: false, untracked: true } };
    const p = plan([
      file('untracked', 'scratch.txt', { origin: untrackedOrigin }),
      file('renamed', 'new.ts', { oldPath: 'old.ts', origin: uncommitted }),
      file('deleted', 'gone.ts', { origin: uncommitted }),
    ]);
    expect(p.losesUncommitted).toEqual([]);
  });

  it('counts a file selected twice once', () => {
    const a = file('modified', 'a.ts');
    expect(plan([a, a]).files).toEqual([a]);
  });

  it('returns the reason instead of a plan for a branch', () => {
    const planned = planRevert(result({ subject: { kind: 'ref', ref: 'feature', label: 'feature' }, subjectRevision: 'sha:feature' }), [file('modified', 'a.ts')]);
    expect(planned).toEqual({ reason: expect.stringContaining('files on disk') });
  });
});

describe('leftSideName', () => {
  it('names the Against side in direct mode', () => {
    expect(leftSideName(result())).toBe('origin/main');
  });

  it('names the Against side when the branch point is its tip', () => {
    expect(leftSideName(result({ mode: 'merge-base', branchPoint: { isAgainstTip: true } }))).toBe('origin/main');
  });

  it('names the branch point when the Against side has moved on', () => {
    expect(leftSideName(result({ mode: 'merge-base', branchPoint: { isAgainstTip: false } }))).toBe('the branch point abc1234 of origin/main');
  });

  it('falls back to generic wording without a label', () => {
    expect(leftSideName(result({ baseLabel: undefined }))).toBe('the Against side');
  });
});

describe('revertConfirmation', () => {
  it('names a single file and says nothing uncommitted is lost', () => {
    const text = revertConfirmation([plan([file('modified', 'a.ts', { origin: { committed: true } })])]);
    expect(text).toEqual({
      title: 'Revert a.ts to origin/main?',
      detail: [
        'Replaced with the version at origin/main: a.ts.',
        'No uncommitted edits are lost: committed versions stay in git history.',
        'Nothing is committed: the result shows as uncommitted edits.',
      ].join('\n'),
      confirm: 'Revert',
    });
  });

  it('counts a rename as one file and names the Trash and lost edits', () => {
    const text = revertConfirmation([
      plan([file('renamed', 'b.ts', { oldPath: 'old-b.ts' }), file('added', 'c.ts'), file('modified', 'd.ts', { origin: uncommitted })]),
    ]);
    expect(text.title).toBe('Revert 3 files to origin/main?');
    expect(text.detail).toContain('Replaced with the version at origin/main: d.ts, old-b.ts.');
    expect(text.detail).toContain('Moved to the Trash (not at origin/main): b.ts, c.ts.');
    expect(text.detail).toContain('Uncommitted edits are lost: d.ts.');
  });

  it('prefixes repo names and avoids naming one Against side for several repos', () => {
    const other = plan([file('modified', 'x.ts')], { repo: repo('web') });
    const text = revertConfirmation([plan([file('modified', 'a.ts')]), other]);
    expect(text.title).toBe('Revert 2 files to their Against sides?');
    expect(text.detail).toContain('svc: a.ts, web: x.ts');
  });
});
