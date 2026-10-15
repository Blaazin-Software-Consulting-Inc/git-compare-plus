import { describe, expect, it, vi } from 'vitest';
import {
  checkBranchDeletion,
  checkWorktreeRemoval,
  defaultWorktreePath,
  formatAge,
  isFetchStale,
  localNameForRemote,
  mapWithConcurrency,
  switchBlockers,
  type OperationsPort,
} from '../src/operations';

function port(overrides: Partial<OperationsPort> = {}): OperationsPort {
  return {
    uncommittedCount: vi.fn(async () => 0),
    defaultBranch: vi.fn(async () => 'origin/master'),
    commitsNotIn: vi.fn(async () => 0),
    ...overrides,
  };
}
const wt = (path: string, branch?: string) => ({ path, branch, detached: branch === undefined, bare: false, prunable: false });

describe('checkWorktreeRemoval', () => {
  it('counts uncommitted + untracked files and flags Claude Code worktrees', async () => {
    const git = port({ uncommittedCount: vi.fn(async () => 4) });
    expect(await checkWorktreeRemoval(git, '/ws/ui/.claude/worktrees/feat')).toEqual({ uncommittedFiles: 4, isClaudeWorktree: true });
    expect(git.uncommittedCount).toHaveBeenCalledWith('/ws/ui/.claude/worktrees/feat', true);
    expect((await checkWorktreeRemoval(port(), '/ws/ui.worktrees/feat')).isClaudeWorktree).toBe(false);
  });
});

describe('checkBranchDeletion', () => {
  it('is blocked when the branch is checked out in any worktree', async () => {
    const git = port();
    expect(await checkBranchDeletion(git, '/r', 'feat', [wt('/r', 'master'), wt('/r.worktrees/feat', 'feat')])).toEqual({
      kind: 'blocked',
      checkedOutIn: '/r.worktrees/feat',
    });
    expect(git.commitsNotIn).not.toHaveBeenCalled();
  });

  it('counts commits not on the default branch', async () => {
    const git = port({ commitsNotIn: vi.fn(async () => 3) });
    expect(await checkBranchDeletion(git, '/r', 'feat', [wt('/r', 'master')])).toEqual({ kind: 'ok', comparedWith: 'origin/master', unmergedCommits: 3 });
    expect(git.commitsNotIn).toHaveBeenCalledWith('/r', 'feat', 'origin/master');
  });

  it('is unknown when there is no default branch to compare with', async () => {
    const result = await checkBranchDeletion(port({ defaultBranch: vi.fn(async () => undefined) }), '/r', 'feat', []);
    expect(result.kind).toBe('unknown');
  });
});

describe('switchBlockers', () => {
  it('counts tracked changes only (untracked files do not block a switch)', async () => {
    const git = port({ uncommittedCount: vi.fn(async () => 2) });
    expect(await switchBlockers(git, '/r')).toBe(2);
    expect(git.uncommittedCount).toHaveBeenCalledWith('/r', false);
  });
});

describe('naming', () => {
  it('strips only the remote name from a remote branch', () => {
    expect(localNameForRemote('origin/feature/x')).toBe('feature/x');
    expect(localNameForRemote('upstream/main')).toBe('main');
    expect(localNameForRemote('nobranch')).toBe('nobranch');
  });

  it('suggests a sibling <repo>.worktrees/<flattened-branch> folder', () => {
    expect(defaultWorktreePath('/ws/club-service', 'feature/DRR-1 fix')).toBe('/ws/club-service.worktrees/feature-DRR-1-fix');
    expect(defaultWorktreePath('/ws/club-service', '///')).toBe('/ws/club-service.worktrees/worktree');
  });
});

describe('formatAge / isFetchStale', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  it('formats each range', () => {
    expect(formatAge(undefined, now)).toBe('never');
    expect(formatAge(now - 10_000, now)).toBe('just now');
    expect(formatAge(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatAge(now - 24 * 3_600_000, now)).toBe('1 day ago');
    expect(formatAge(now - 72 * 3_600_000, now)).toBe('3 days ago');
    expect(formatAge(now + 60_000, now)).toBe('just now');
  });

  it('is stale when never fetched or older than the threshold', () => {
    expect(isFetchStale(undefined, now, 24)).toBe(true);
    expect(isFetchStale(now - 25 * 3_600_000, now, 24)).toBe(true);
    expect(isFetchStale(now - 23 * 3_600_000, now, 24)).toBe(false);
  });
});

describe('mapWithConcurrency', () => {
  it('keeps order, isolates failures, and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 3) {
        throw new Error('three');
      }
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 'x', 40, 50]);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
