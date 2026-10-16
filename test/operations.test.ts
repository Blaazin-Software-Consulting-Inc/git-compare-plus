import { describe, expect, it, vi } from 'vitest';
import {
  checkBranchDeletion,
  checkWorktreeRemoval,
  defaultWorktreePath,
  formatAge,
  isFetchStale,
  localNameForRemote,
  mapWithConcurrency,
  planBranchDeletions,
  planWorktreeRemovals,
  selectionTargets,
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

describe('selectionTargets', () => {
  it('uses the whole selection when the clicked item is part of it', () => {
    expect(selectionTargets('b', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('uses only the clicked item when it is outside the selection', () => {
    expect(selectionTargets('z', ['a', 'b'])).toEqual(['z']);
  });
  it('handles no selection, and the Delete key (no clicked item)', () => {
    expect(selectionTargets('a', undefined)).toEqual(['a']);
    expect(selectionTargets(undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(selectionTargets(undefined, [])).toEqual([]);
  });
});

describe('planBranchDeletions', () => {
  const ok = (repoName: string, branch: string, unmergedCommits: number) => ({
    repoName,
    branch,
    check: { kind: 'ok' as const, comparedWith: 'origin/master', unmergedCommits },
  });

  it('single merged branch: plain wording', () => {
    const { confirmation, deletable } = planBranchDeletions([ok('svc', 'feat', 0)]);
    expect(deletable).toHaveLength(1);
    expect(confirmation).toMatchObject({ title: 'Delete branch feat?', confirm: 'Delete Branch' });
    expect(confirmation?.detail).toContain('• feat: all commits are in origin/master');
  });

  it('several branches: per-branch lines, total lost commits on the button, skipped listed', () => {
    const plan = planBranchDeletions(
      [ok('svc', 'a', 2), ok('svc', 'b', 0), ok('svc', 'c', 1), { repoName: 'svc', branch: 'master', check: { kind: 'blocked', checkedOutIn: '/ws/svc' } }],
      [{ label: 'origin/x', reason: 'remote branch' }],
    );
    expect(plan.deletable.map((c) => c.branch)).toEqual(['a', 'b', 'c']);
    expect(plan.confirmation).toMatchObject({ title: 'Delete 3 branches?', confirm: 'Delete and Lose 3 Commits' });
    expect(plan.confirmation?.detail).toContain('• a: 2 commits not in origin/master will be lost');
    expect(plan.confirmation?.detail).toContain('3 commits in total will be lost');
    expect(plan.confirmation?.detail).toContain('• master: checked out in /ws/svc');
    expect(plan.confirmation?.detail).toContain('• origin/x: remote branch');
  });

  it('prefixes repo names when the selection spans repos; unknown check → Delete Anyway', () => {
    const plan = planBranchDeletions([ok('svc', 'a', 0), { repoName: 'lib', branch: 'b', check: { kind: 'unknown', reason: 'x' } }]);
    expect(plan.confirmation?.detail).toContain('• svc: a:');
    expect(plan.confirmation?.detail).toContain('• lib: b: could not check');
    expect(plan.confirmation?.confirm).toBe('Delete Anyway');
  });

  it('no confirmation when everything is blocked', () => {
    const plan = planBranchDeletions([{ repoName: 'svc', branch: 'master', check: { kind: 'blocked', checkedOutIn: '/ws/svc' } }]);
    expect(plan.confirmation).toBeUndefined();
    expect(plan.skipped).toEqual([{ label: 'master', reason: 'checked out in /ws/svc' }]);
  });

  it('truncates long lists', () => {
    const many = Array.from({ length: 20 }, (_, i) => ok('svc', `b${i}`, 0));
    const detail = planBranchDeletions(many).confirmation?.detail ?? '';
    expect(detail).toContain('…and 5 more');
    expect(detail).not.toContain('• b19');
  });
});

describe('planWorktreeRemovals', () => {
  const cand = (name: string, files: number, claude = false) => ({
    repoName: 'svc',
    name,
    path: `/ws/svc.worktrees/${name}`,
    detached: false,
    check: { uncommittedFiles: files, isClaudeWorktree: claude },
  });

  it('single clean worktree', () => {
    expect(planWorktreeRemovals([cand('feat', 0)])).toMatchObject({ title: 'Remove worktree feat?', confirm: 'Remove Worktree' });
  });

  it('several: totals lost files on the button and flags Claude worktrees and skipped items', () => {
    const text = planWorktreeRemovals([cand('a', 2), cand('b', 0), cand('c', 1, true)], [{ label: 'svc (main worktree)', reason: 'cannot be removed' }]);
    expect(text).toMatchObject({ title: 'Remove 3 worktrees?', confirm: 'Remove and Discard 3 Files' });
    expect(text?.detail).toContain('• a: /ws/svc.worktrees/a, 2 uncommitted files will be PERMANENTLY DELETED');
    expect(text?.detail).toContain('3 uncommitted files in total will be permanently deleted.');
    expect(text?.detail).toContain('Created by Claude Code');
    expect(text?.detail).toContain('• svc (main worktree): cannot be removed');
  });

  it('nothing removable → undefined', () => {
    expect(planWorktreeRemovals([])).toBeUndefined();
  });
});
