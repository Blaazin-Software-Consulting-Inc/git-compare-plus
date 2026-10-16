import { describe, expect, it } from 'vitest';
import type { RefEntry, WorktreeEntry } from '../src/git/parsers';
import { sortBranches, sortWorktrees } from '../src/treeOrder';

const DAY = 86_400_000;
const local = (name: string, daysAgo?: number): RefEntry => ({
  name,
  kind: 'local',
  sha: name,
  isHead: false,
  committedAt: daysAgo === undefined ? undefined : 1_000 * DAY - daysAgo * DAY,
});
const remote = (name: string, daysAgo: number): RefEntry => ({ ...local(name, daysAgo), kind: 'remote' });
const wt = (path: string, branch: string | undefined, head: string): WorktreeEntry => ({ path, branch, head, detached: branch === undefined, bare: false, prunable: false });

describe('sortBranches', () => {
  it('pins the default branch, then main, then master; the rest newest first', () => {
    const order = sortBranches([local('old', 30), local('master', 90), local('new', 1), local('main', 60), local('mid', 7)], 'origin/master');
    expect(order.map((r) => r.name)).toEqual(['master', 'main', 'new', 'mid', 'old']);
  });

  it('without a known default branch, main comes before master', () => {
    expect(sortBranches([local('master', 1), local('feat', 0), local('main', 5)], undefined).map((r) => r.name)).toEqual(['main', 'master', 'feat']);
  });

  it('pins remote branches by their name without the remote', () => {
    const order = sortBranches([remote('origin/feat', 1), remote('origin/master', 50), remote('origin/develop', 2)], 'origin/master');
    expect(order.map((r) => r.name)).toEqual(['origin/master', 'origin/feat', 'origin/develop']);
  });

  it('breaks date ties by name and puts undated entries last', () => {
    expect(sortBranches([local('b', 3), local('a', 3), local('nodate')], undefined).map((r) => r.name)).toEqual(['a', 'b', 'nodate']);
  });

  it('handles an empty list', () => {
    expect(sortBranches([], 'origin/main')).toEqual([]);
  });
});

describe('sortWorktrees', () => {
  const dates = new Map([
    ['h-main', 1_000 * DAY - 40 * DAY],
    ['h-old', 1_000 * DAY - 20 * DAY],
    ['h-new', 1_000 * DAY - 1 * DAY],
    ['h-master', 1_000 * DAY - 90 * DAY],
  ]);

  it('keeps the main worktree first, then pinned branches, then newest HEAD first', () => {
    const order = sortWorktrees(
      [wt('/repo', 'feature-x', 'h-main'), wt('/wt/old', 'old', 'h-old'), wt('/wt/new', 'new', 'h-new'), wt('/wt/master', 'master', 'h-master')],
      'origin/master',
      dates,
    );
    expect(order.map((w) => w.path)).toEqual(['/repo', '/wt/master', '/wt/new', '/wt/old']);
  });

  it('places detached worktrees by date like any other', () => {
    const order = sortWorktrees([wt('/repo', 'master', 'h-main'), wt('/wt/old', 'old', 'h-old'), wt('/wt/det', undefined, 'h-new')], 'origin/master', dates);
    expect(order.map((w) => w.path)).toEqual(['/repo', '/wt/det', '/wt/old']);
  });

  it('handles a repo with no worktrees listed', () => {
    expect(sortWorktrees([], undefined, new Map())).toEqual([]);
  });
});
