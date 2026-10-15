import { describe, expect, it } from 'vitest';
import { RefType, rankBranchCandidates } from '../src/branchCandidates';

const head = (name: string) => ({ type: RefType.Head, name });
const remote = (name: string) => ({ type: RefType.RemoteHead, name });

describe('rankBranchCandidates', () => {
  it('puts conventional integration branches first, remote before local', () => {
    const ranked = rankBranchCandidates([
      [head('feature/x'), head('main'), remote('origin/main'), head('master'), remote('origin/master')],
    ]);
    expect(ranked.map((c) => c.ref)).toEqual(['origin/master', 'origin/main', 'master', 'main', 'feature/x']);
  });

  it('counts each repo once per branch and orders the rest by repo count, then name', () => {
    const ranked = rankBranchCandidates([
      [head('feat/b'), head('feat/a'), head('feat/a')],
      [head('feat/b')],
      [head('feat/c')],
    ]);
    expect(ranked).toEqual([
      { ref: 'feat/b', repoCount: 2 },
      { ref: 'feat/a', repoCount: 1 },
      { ref: 'feat/c', repoCount: 1 },
    ]);
  });

  it('excludes tags, symbolic */HEAD refs, and unnamed refs', () => {
    const ranked = rankBranchCandidates([
      [{ type: RefType.Tag, name: 'v1.0.0' }, remote('origin/HEAD'), { type: RefType.Head }, head('dev')],
    ]);
    expect(ranked.map((c) => c.ref)).toEqual(['dev']);
  });

  it('returns an empty list when there are no repos or refs', () => {
    expect(rankBranchCandidates([])).toEqual([]);
    expect(rankBranchCandidates([[]])).toEqual([]);
  });
});
