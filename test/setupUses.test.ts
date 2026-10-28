import { describe, expect, it } from 'vitest';
import { setupUses } from '../src/setupUses';
import type { ComparisonSetup } from '../src/views/changesHeader';
import { repo } from './helpers';

const svc = repo('svc');
const reviewingBranch: ComparisonSetup = {
  requests: [{ repo: svc, subject: { kind: 'ref', ref: 'claude/brave', label: 'claude/brave', refKind: 'branch' } }],
  base: { kind: 'default' },
  mode: 'merge-base',
};
const reviewingWorktree: ComparisonSetup = {
  requests: [{ repo: svc, subject: { kind: 'worktree', root: '/ws/svc/.wt/a', label: 'a', includeUncommitted: true } }],
  base: { kind: 'worktree', root: '/ws/svc/.wt/b', label: 'b', includeUncommitted: false },
  mode: 'direct',
};

describe('setupUses', () => {
  it('finds a deleted branch on the Reviewing side', () => {
    expect(setupUses(reviewingBranch, { kind: 'branch', name: 'claude/brave' })).toBe(true);
    expect(setupUses(reviewingBranch, { kind: 'branch', name: 'claude/other' })).toBe(false);
  });

  it('finds a deleted branch on the Against side, but not a remote branch or tag of that name', () => {
    const against = (refKind: 'branch' | 'remote' | 'tag' | undefined): ComparisonSetup => ({ ...reviewingWorktree, base: { kind: 'ref', ref: 'develop', refKind } });
    expect(setupUses(against('branch'), { kind: 'branch', name: 'develop' })).toBe(true);
    expect(setupUses(against(undefined), { kind: 'branch', name: 'develop' })).toBe(true);
    expect(setupUses(against('remote'), { kind: 'branch', name: 'develop' })).toBe(false);
    expect(setupUses(against('tag'), { kind: 'branch', name: 'develop' })).toBe(false);
  });

  it('finds a removed worktree on either side, however its path is spelled', () => {
    expect(setupUses(reviewingWorktree, { kind: 'worktree', root: '/ws/svc/.wt/a/' })).toBe(true);
    expect(setupUses(reviewingWorktree, { kind: 'worktree', root: '/ws/svc/.wt/b' })).toBe(true);
    expect(setupUses(reviewingWorktree, { kind: 'worktree', root: '/ws/svc/.wt/c' })).toBe(false);
  });

  it('never matches the default branch Against side', () => {
    expect(setupUses(reviewingBranch, { kind: 'worktree', root: '/ws/svc' })).toBe(false);
  });
});
