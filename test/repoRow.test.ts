import { describe, expect, it } from 'vitest';
import { repoRowDescription, repoRowUncommittedTooltip } from '../src/repoRow';

const dirty = { staged: 0, unstaged: 2, untracked: 29, total: 31 };
const clean = { staged: 0, unstaged: 0, untracked: 0, total: 0 };

describe('repoRowDescription', () => {
  it("shows the main worktree's uncommitted work next to its branch", () => {
    expect(repoRowDescription({ branch: 'main', uncommitted: dirty, against: 'origin/main', fetched: 'fetched 2 hours ago' })).toBe(
      'main · ✎ 31 uncommitted · against origin/main · fetched 2 hours ago',
    );
  });

  it('says nothing about uncommitted work when the main worktree is clean or its status is unknown', () => {
    expect(repoRowDescription({ branch: 'main', uncommitted: clean, against: 'origin/main' })).toBe('main · against origin/main');
    expect(repoRowDescription({ branch: 'main', against: 'origin/main' })).toBe('main · against origin/main');
  });

  it('leaves out parts not loaded yet', () => {
    expect(repoRowDescription({})).toBe('');
    expect(repoRowDescription({ uncommitted: dirty })).toBe('✎ 31 uncommitted');
  });
});

describe('repoRowUncommittedTooltip', () => {
  it('says which worktree the files are in', () => {
    expect(repoRowUncommittedTooltip(dirty)).toBe('31 uncommitted files: 2 changed but not staged, 29 untracked (main worktree)');
  });

  it('is undefined for a clean or unknown main worktree', () => {
    expect(repoRowUncommittedTooltip(clean)).toBeUndefined();
    expect(repoRowUncommittedTooltip(undefined)).toBeUndefined();
  });
});
