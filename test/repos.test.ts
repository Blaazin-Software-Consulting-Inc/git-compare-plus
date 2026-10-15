import { describe, expect, it } from 'vitest';
import { groupRepos } from '../src/repos';

describe('groupRepos', () => {
  it('folds a linked worktree into its repo, represented by the main worktree', () => {
    expect(
      groupRepos([
        { root: '/ws/ui/.claude/worktrees/x', commonDir: '/ws/ui/.git', mainWorktree: '/ws/ui' },
        { root: '/ws/ui', commonDir: '/ws/ui/.git', mainWorktree: '/ws/ui' },
        { root: '/ws/api', commonDir: '/ws/api/.git', mainWorktree: '/ws/api' },
      ]),
    ).toEqual([
      { name: 'ui', root: '/ws/ui', commonDir: '/ws/ui/.git' },
      { name: 'api', root: '/ws/api', commonDir: '/ws/api/.git' },
    ]);
  });

  it('falls back to the discovered root when the main worktree is unknown', () => {
    expect(groupRepos([{ root: '/ws/solo', commonDir: '/ws/solo/.git' }])).toEqual([
      { name: 'solo', root: '/ws/solo', commonDir: '/ws/solo/.git' },
    ]);
  });

  it('returns an empty list for no probes', () => {
    expect(groupRepos([])).toEqual([]);
  });
});
