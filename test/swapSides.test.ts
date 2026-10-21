import { describe, expect, it } from 'vitest';
import type { BaseSpec, ComparisonRequest, ComparisonResult } from '../src/comparison';
import { swapSides } from '../src/swapSides';
import type { ComparisonSetup } from '../src/views/changesHeader';
import { repo } from './helpers';

const request = (subject: ComparisonRequest['subject']): ComparisonRequest => ({ repo: repo('svc'), subject });
const result = (baseLabel?: string): ComparisonResult => ({
  repo: repo('svc'),
  subject: { kind: 'ref', ref: 'x', label: 'x' },
  outcome: 'compared',
  mode: 'merge-base',
  baseLabel,
  excludedUncommitted: {},
  files: [],
});
const setup = (requests: ComparisonRequest[], base: BaseSpec): ComparisonSetup => ({ requests, base, mode: 'merge-base' });

describe('swapSides', () => {
  it('swaps a branch with the default branch, using the branch the default resolved to', () => {
    const outcome = swapSides(setup([request({ kind: 'ref', ref: 'feature', label: 'feature' })], { kind: 'default' }), [result('origin/master')]);
    expect(outcome).toEqual({
      setup: { requests: [request({ kind: 'ref', ref: 'origin/master', label: 'origin/master' })], base: { kind: 'ref', ref: 'feature' }, mode: 'merge-base' },
    });
  });

  it('keeps whether each worktree side includes uncommitted edits', () => {
    const subject = { kind: 'worktree' as const, root: '/wt', label: 'feature', includeUncommitted: true };
    const base: BaseSpec = { kind: 'worktree', root: '/main', label: 'main', includeUncommitted: false };
    const outcome = swapSides(setup([request(subject)], base), [result('main')]);
    expect(outcome).toEqual({
      setup: {
        requests: [request({ kind: 'worktree', root: '/main', label: 'main', includeUncommitted: false })],
        base: { kind: 'worktree', root: '/wt', label: 'feature', includeUncommitted: true },
        mode: 'merge-base',
      },
    });
  });

  it('swaps a ref base by name', () => {
    const outcome = swapSides(setup([request({ kind: 'ref', ref: 'a', label: 'a' })], { kind: 'ref', ref: 'v1.2' }), [result('v1.2')]);
    expect('setup' in outcome && outcome.setup.requests[0]?.subject).toEqual({ kind: 'ref', ref: 'v1.2', label: 'v1.2' });
  });

  it('refuses multi-repo comparisons and an unresolved default branch, with a reason', () => {
    const two = [request({ kind: 'ref', ref: 'a', label: 'a' }), request({ kind: 'ref', ref: 'b', label: 'b' })];
    expect(swapSides(setup(two, { kind: 'default' }), [result('m'), result('m')])).toMatchObject({ reason: expect.stringContaining('one repository') });
    expect(swapSides(setup([two[0] as ComparisonRequest], { kind: 'default' }), [result(undefined)])).toMatchObject({ reason: expect.stringContaining("wasn't found") });
  });
});
