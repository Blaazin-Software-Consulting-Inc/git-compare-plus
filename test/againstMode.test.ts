import { describe, expect, it } from 'vitest';
import { modeForAgainst } from '../src/againstMode';
import type { BaseSpec } from '../src/comparison';

const worktree: BaseSpec = { kind: 'worktree', root: '/r/.wt/other', label: 'other', includeUncommitted: false };
const branch: BaseSpec = { kind: 'ref', ref: 'feature-b', refKind: 'branch' };
const remote: BaseSpec = { kind: 'ref', ref: 'origin/feature-b', refKind: 'remote' };
const tag: BaseSpec = { kind: 'ref', ref: 'v1.0.0', refKind: 'tag' };
const commit: BaseSpec = { kind: 'ref', ref: 'abc1234', refKind: 'commit' };
const typed: BaseSpec = { kind: 'ref', ref: 'HEAD~3' };

describe('modeForAgainst', () => {
  it('keeps the setting against the default branch', () => {
    expect(modeForAgainst({ kind: 'default' }, undefined, 'merge-base')).toBe('merge-base');
    expect(modeForAgainst({ kind: 'default' }, undefined, 'direct')).toBe('direct');
  });

  it.each([
    ['a worktree', worktree],
    ['a local branch', branch],
    ['a remote branch', remote],
  ])('starts with all differences against %s', (_name, against) => {
    expect(modeForAgainst(against, undefined, 'merge-base')).toBe('direct');
  });

  it.each([
    ['a tag', tag],
    ['a commit', commit],
    ['a typed ref', typed],
  ])('keeps the setting against %s', (_name, against) => {
    expect(modeForAgainst(against, undefined, 'merge-base')).toBe('merge-base');
  });

  it("keeps the setting against the repo's saved default Against, even a branch or worktree", () => {
    expect(modeForAgainst(branch, { kind: 'ref', ref: 'feature-b' }, 'merge-base')).toBe('merge-base');
    expect(modeForAgainst(worktree, { ...worktree, includeUncommitted: true }, 'merge-base')).toBe('merge-base');
  });

  it('treats a different branch or worktree than the saved default Against as picked', () => {
    expect(modeForAgainst(branch, { kind: 'ref', ref: 'develop' }, 'merge-base')).toBe('direct');
    expect(modeForAgainst(worktree, { kind: 'default' }, 'merge-base')).toBe('direct');
    expect(modeForAgainst(worktree, { ...worktree, root: '/r/.wt/third' }, 'merge-base')).toBe('direct');
  });

  it('never turns an all-differences setting into since-branch-point', () => {
    for (const against of [worktree, branch, remote, tag, commit, typed]) {
      expect(modeForAgainst(against, undefined, 'direct')).toBe('direct');
    }
  });
});
