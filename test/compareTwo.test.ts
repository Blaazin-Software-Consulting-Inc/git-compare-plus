import { describe, expect, it } from 'vitest';
import type { Subject } from '../src/comparison';
import { compareTwoChoices, type PairSide } from '../src/compareTwo';
import { repo } from './helpers';

const svc = repo('svc');
const side = (subject: Subject, r = svc): PairSide => ({ repo: r, subject });
const worktreeA = side({ kind: 'worktree', root: '/ws/svc/.wt/a', label: 'feature-a', includeUncommitted: true });
const worktreeB = side({ kind: 'worktree', root: '/ws/svc/.wt/b', label: 'feature-b', includeUncommitted: false });
const branchC = side({ kind: 'ref', ref: 'feature-c', label: 'feature-c', refKind: 'branch' });

describe('compareTwoChoices', () => {
  it('offers both directions, the first selected row reviewed first, each in all-differences mode', () => {
    const outcome = compareTwoChoices(worktreeA, worktreeB);
    expect('choices' in outcome).toBe(true);
    if (!('choices' in outcome)) {
      return;
    }
    expect(outcome.choices.map((c) => c.label)).toEqual(['Review feature-a against feature-b', 'Review feature-b against feature-a']);
    expect(outcome.choices.every((c) => c.setup.mode === 'direct')).toBe(true);
  });

  it('makes the other row the Against side, keeping whether it includes uncommitted edits', () => {
    const outcome = compareTwoChoices(worktreeA, worktreeB);
    if (!('choices' in outcome)) {
      throw new Error('expected choices');
    }
    const [aAgainstB, bAgainstA] = outcome.choices;
    expect(aAgainstB?.setup.requests).toEqual([{ repo: svc, subject: worktreeA.subject }]);
    expect(aAgainstB?.setup.base).toEqual({ kind: 'worktree', root: '/ws/svc/.wt/b', label: 'feature-b', includeUncommitted: false });
    expect(bAgainstA?.setup.base).toEqual({ kind: 'worktree', root: '/ws/svc/.wt/a', label: 'feature-a', includeUncommitted: true });
  });

  it('says which side is on which side of the diff, and what a worktree side reads', () => {
    const outcome = compareTwoChoices(worktreeA, branchC);
    if (!('choices' in outcome)) {
      throw new Error('expected choices');
    }
    expect(outcome.choices[0]?.detail).toBe('feature-a (files on disk) on the right of every diff; feature-c on the left. All differences between them.');
    expect(outcome.choices[1]?.detail).toContain('feature-c on the right');
    expect(outcome.choices[0]?.setup.base).toEqual({ kind: 'ref', ref: 'feature-c', label: 'feature-c', refKind: 'branch' });
  });

  it('refuses rows from different repositories', () => {
    const outcome = compareTwoChoices(worktreeA, side(branchC.subject, repo('web')));
    expect(outcome).toEqual({ reason: expect.stringContaining('different repositories (svc, web)') });
  });

  it('refuses the same worktree or branch twice', () => {
    expect(compareTwoChoices(branchC, branchC)).toEqual({ reason: expect.stringContaining('Both rows are feature-c') });
    expect(compareTwoChoices(worktreeA, { ...worktreeA })).toEqual({ reason: expect.stringContaining('Both rows are feature-a') });
  });
});
