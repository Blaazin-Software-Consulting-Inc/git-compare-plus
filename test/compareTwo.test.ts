import { describe, expect, it, vi } from 'vitest';
import type { Subject } from '../src/comparison';
import { compareTwoChoices, useAsAgainst, type PairSide } from '../src/compareTwo';
import type { ComparisonSetup } from '../src/views/changesHeader';
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

describe('useAsAgainst', () => {
  const web = repo('web');
  const shown: ComparisonSetup = { requests: [{ repo: svc, subject: worktreeA.subject }], base: { kind: 'default' }, mode: 'merge-base' };
  const pickedMode = () => 'direct' as const;

  it("makes the row the Against side of what Changes shows, keeping what is reviewed", () => {
    const outcome = useAsAgainst(shown, branchC, pickedMode);
    expect(outcome).toEqual({
      setup: { requests: shown.requests, base: { kind: 'ref', ref: 'feature-c', label: 'feature-c', refKind: 'branch' }, mode: 'direct' },
    });
  });

  it("keeps a worktree row's uncommitted choice on the Against side", () => {
    const outcome = useAsAgainst(shown, worktreeB, pickedMode);
    expect('setup' in outcome && outcome.setup.base).toEqual({ kind: 'worktree', root: '/ws/svc/.wt/b', label: 'feature-b', includeUncommitted: false });
  });

  it("starts in the mode againstMode picks for that Against", () => {
    const modeFor = vi.fn(() => 'merge-base' as const);
    const outcome = useAsAgainst(shown, branchC, modeFor);
    expect(modeFor).toHaveBeenCalledWith(svc, { kind: 'ref', ref: 'feature-c', label: 'feature-c', refKind: 'branch' });
    expect('setup' in outcome && outcome.setup.mode).toBe('merge-base');
  });

  it("narrows a several-repo comparison to the row's repo", () => {
    const both: ComparisonSetup = { ...shown, requests: [...shown.requests, { repo: web, subject: { kind: 'worktree', root: '/ws/web', label: 'main', includeUncommitted: true } }] };
    const outcome = useAsAgainst(both, branchC, pickedMode);
    expect('setup' in outcome && outcome.setup.requests.map((r) => r.repo.name)).toEqual(['svc']);
  });

  it('refuses a row from a repo Changes is not reviewing, or the row being reviewed', () => {
    expect(useAsAgainst(shown, side(branchC.subject, web), pickedMode)).toEqual({ reason: expect.stringContaining('Changes is reviewing svc, not web') });
    expect(useAsAgainst(shown, worktreeA, pickedMode)).toEqual({ reason: expect.stringContaining('feature-a is what Changes is reviewing') });
  });
});
