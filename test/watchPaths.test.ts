import { describe, expect, it } from 'vitest';
import { involvedCommonDirs, isIgnoredChange, watchedRoots } from '../src/autoRefresh/watchPaths';
import type { ComparisonSetup } from '../src/views/changesHeader';
import { repo } from './helpers';

describe('isIgnoredChange', () => {
  it('reacts to source files', () => {
    expect(isIgnoredChange('/wt', '/wt/src/a.ts')).toBe(false);
    expect(isIgnoredChange('/wt', '/wt/README.md')).toBe(false);
  });

  it('ignores git internals, dependencies and build output at any depth', () => {
    for (const p of ['/wt/.git/index', '/wt/node_modules/x/y.js', '/wt/packages/a/dist/b.js', '/wt/cdk.out/t.json', '/wt/.aws-sam/build/x']) {
      expect(isIgnoredChange('/wt', p)).toBe(true);
    }
  });

  it('does not ignore names that merely contain an ignored word', () => {
    expect(isIgnoredChange('/wt', '/wt/src/distance.ts')).toBe(false);
    expect(isIgnoredChange('/wt', '/wt/builder/x.ts')).toBe(false);
  });

  it('ignores paths outside the root and the root itself', () => {
    expect(isIgnoredChange('/wt', '/other/a.ts')).toBe(true);
    expect(isIgnoredChange('/wt', '/wt')).toBe(true);
  });
});

describe('watchedRoots / involvedCommonDirs', () => {
  const setup = (overrides: Partial<ComparisonSetup>): ComparisonSetup => ({
    requests: [
      { repo: repo('svc'), subject: { kind: 'worktree', root: '/ws/svc.worktrees/feat', label: 'feat', includeUncommitted: true } },
      { repo: repo('lib'), subject: { kind: 'ref', ref: 'x', label: 'x' } },
    ],
    base: { kind: 'default' },
    mode: 'merge-base',
    ...overrides,
  });

  it('watches worktree subjects only (branches have no folder)', () => {
    expect(watchedRoots(setup({}))).toEqual(['/ws/svc.worktrees/feat']);
  });

  it('adds a worktree base and de-duplicates', () => {
    expect(watchedRoots(setup({ base: { kind: 'worktree', root: '/ws/svc', label: 'master', includeUncommitted: true } }))).toEqual([
      '/ws/svc',
      '/ws/svc.worktrees/feat',
    ]);
    expect(watchedRoots(setup({ base: { kind: 'worktree', root: '/ws/svc.worktrees/feat', label: 'f', includeUncommitted: false } }))).toEqual([
      '/ws/svc.worktrees/feat',
    ]);
  });

  it('collects every repo in the comparison', () => {
    expect([...involvedCommonDirs(setup({}))].sort()).toEqual(['/ws/lib/.git', '/ws/svc/.git']);
  });
});
