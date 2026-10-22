import { describe, expect, it, vi } from 'vitest';
import { BRANCH_COMMITS_LIMIT, loadBranchCommits, type BranchCommitsPort, type BranchCommitsRequest } from '../src/commits/branchCommits';
import type { CommitEntry } from '../src/git/parsers';

const commit = (sha: string): CommitEntry => ({ sha, parents: [], author: 'a', authoredAt: 1, subject: sha });
const many = (n: number) => Array.from({ length: n }, (_, i) => commit(`c${i}`));
const request: BranchCommitsRequest = { cwd: '/r', revision: 'feature-x', label: 'feature-x', against: { label: 'origin/main', commitish: 'origin/main' } };

function port(ahead: CommitEntry[], history: CommitEntry[], shas: Record<string, string> = { 'origin/main': 'm', 'feature-x': 'f' }) {
  return {
    resolveCommit: vi.fn(async (_cwd: string, revision: string) => shas[revision]),
    commitsBetween: vi.fn(async () => ahead),
    log: vi.fn(async () => history),
  } satisfies { [K in keyof BranchCommitsPort]: ReturnType<typeof vi.fn> & BranchCommitsPort[K] };
}

describe('loadBranchCommits', () => {
  it('lists what the branch has that the default Against does not', async () => {
    const git = port(many(3), many(50));
    const result = await loadBranchCommits(git, request, 'auto');
    expect(git.commitsBetween).toHaveBeenCalledWith('/r', 'm', 'f', BRANCH_COMMITS_LIMIT + 1);
    expect(git.log).not.toHaveBeenCalled();
    expect(result).toMatchObject({ shown: 'ahead', truncated: false, description: '3 commits not on origin/main' });
    expect(result.commits).toHaveLength(3);
  });

  it('falls back to history, and says why, when there is nothing ahead', async () => {
    const result = await loadBranchCommits(port([], many(2)), request, 'auto');
    expect(result).toMatchObject({ shown: 'history', description: "history · 2 commits · nothing that origin/main doesn't have" });
  });

  it('does not walk history twice when the branch IS the default Against', async () => {
    const git = port(many(3), many(1), { 'origin/main': 'same', 'feature-x': 'same' });
    const result = await loadBranchCommits(git, request, 'auto');
    expect(git.commitsBetween).not.toHaveBeenCalled();
    expect(result.description).toBe("history · 1 commit · nothing that origin/main doesn't have");
  });

  it('always shows history in history mode, and when there is no default Against', async () => {
    const git = port(many(3), many(4));
    expect((await loadBranchCommits(git, request, 'history')).description).toBe('history · 4 commits');
    expect(git.commitsBetween).not.toHaveBeenCalled();
    expect((await loadBranchCommits(port(many(3), many(1)), { ...request, against: undefined }, 'auto')).description).toBe('history · 1 commit');
  });

  it('marks long lists as cut off at the limit', async () => {
    const ahead = await loadBranchCommits(port(many(BRANCH_COMMITS_LIMIT + 1), []), request, 'auto');
    expect(ahead).toMatchObject({ truncated: true, description: `${BRANCH_COMMITS_LIMIT}+ commits not on origin/main` });
    expect(ahead.commits).toHaveLength(BRANCH_COMMITS_LIMIT);
    const history = await loadBranchCommits(port([], many(BRANCH_COMMITS_LIMIT + 1)), request, 'history');
    expect(history.description).toBe(`history · ${BRANCH_COMMITS_LIMIT}+ commits`);
  });
});
