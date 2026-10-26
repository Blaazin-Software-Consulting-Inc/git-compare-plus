import { describe, expect, it } from 'vitest';
import { uncommittedText, uncommittedTooltip } from '../src/uncommitted';

const counts = (staged: number, unstaged: number, untracked: number, total: number) => ({ staged, unstaged, untracked, total });

describe('uncommittedText', () => {
  it('shows the number of uncommitted files', () => {
    expect(uncommittedText(counts(1, 2, 1, 3))).toBe('✎ 3 uncommitted');
  });

  it('is empty for a clean worktree or unknown counts', () => {
    expect(uncommittedText(counts(0, 0, 0, 0))).toBe('');
    expect(uncommittedText(undefined)).toBe('');
  });
});

describe('uncommittedTooltip', () => {
  it('breaks the total down by kind, leaving out kinds with none', () => {
    expect(uncommittedTooltip(counts(1, 2, 1, 3))).toBe('3 uncommitted files: 1 staged, 2 changed but not staged, 1 untracked');
    expect(uncommittedTooltip(counts(0, 1, 0, 1))).toBe('1 uncommitted file: 1 changed but not staged');
  });

  it('is undefined for a clean worktree', () => {
    expect(uncommittedTooltip(counts(0, 0, 0, 0))).toBeUndefined();
    expect(uncommittedTooltip(undefined)).toBeUndefined();
  });
});
