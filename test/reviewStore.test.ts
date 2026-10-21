import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../src/baseStore';
import { ReviewStore } from '../src/review/reviewStore';
import { groupReviewToggles } from '../src/review/reviewToggles';

function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: (key) => data[key],
    update: async (key, value) => {
      data[key] = value;
    },
  };
}

describe('ReviewStore', () => {
  it('marks and unmarks a file diff, per repo', async () => {
    const store = new ReviewStore(memoryStore());
    await store.set('/a/.git', [{ path: 'x.ts', fingerprint: 'L>R' }], true, 1);
    expect(store.isReviewed('/a/.git', 'x.ts', 'L>R')).toBe(true);
    expect(store.isReviewed('/b/.git', 'x.ts', 'L>R')).toBe(false);
    await store.set('/a/.git', [{ path: 'x.ts', fingerprint: 'L>R' }], false, 2);
    expect(store.isReviewed('/a/.git', 'x.ts', 'L>R')).toBe(false);
  });

  it('a mark lapses when the fingerprint changes (file edited on either side)', async () => {
    const store = new ReviewStore(memoryStore());
    await store.set('/a/.git', [{ path: 'x.ts', fingerprint: 'L>R' }], true, 1);
    expect(store.isReviewed('/a/.git', 'x.ts', 'L>R2')).toBe(false);
    expect(store.isReviewed('/a/.git', 'y.ts', 'L>R')).toBe(false);
  });

  it('never reports a file without a fingerprint as reviewed', () => {
    expect(new ReviewStore(memoryStore()).isReviewed('/a/.git', 'x.ts', undefined)).toBe(false);
  });

  it('keeps other repos when writing one, and skips empty writes', async () => {
    const backing = memoryStore();
    const store = new ReviewStore(backing);
    await store.set('/a/.git', [{ path: 'x', fingerprint: 'f' }], true, 1);
    await store.set('/b/.git', [{ path: 'y', fingerprint: 'g' }], true, 2);
    const before = backing.data['branchCompare.reviewedByRepo'];
    await store.set('/b/.git', [], true, 3);
    expect(backing.data['branchCompare.reviewedByRepo']).toBe(before);
    expect(store.isReviewed('/a/.git', 'x', 'f')).toBe(true);
  });

  it('ignores malformed persisted data', () => {
    expect(new ReviewStore(memoryStore({ 'branchCompare.reviewedByRepo': 'junk' })).isReviewed('/a/.git', 'x', 'f')).toBe(false);
    const wrongValue = memoryStore({ 'branchCompare.reviewedByRepo': { '/a/.git': { 'x\0f': 'yes' } } });
    expect(new ReviewStore(wrongValue).isReviewed('/a/.git', 'x', 'f')).toBe(false);
  });

  it('keeps only the newest 5000 marks per repo', async () => {
    const store = new ReviewStore(memoryStore());
    const marks = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}`, fingerprint: 'x' }));
    await store.set('/a/.git', marks, true, 1);
    await store.set('/a/.git', [{ path: 'newest', fingerprint: 'x' }], true, 2);
    expect(store.isReviewed('/a/.git', 'newest', 'x')).toBe(true);
    const kept = marks.filter((m) => store.isReviewed('/a/.git', m.path, 'x')).length;
    expect(kept).toBe(4999);
  });
});

describe('groupReviewToggles', () => {
  it('groups by repo and direction and lists checked files without a fingerprint', () => {
    const { byRepo, unmarkable } = groupReviewToggles([
      { commonDir: '/a', path: 'x', fingerprint: 'f1', checked: true },
      { commonDir: '/a', path: 'y', fingerprint: 'f2', checked: false },
      { commonDir: '/b', path: 'z', fingerprint: 'f3', checked: true },
      { commonDir: '/b', path: 'nofp', fingerprint: undefined, checked: true },
      { commonDir: '/b', path: 'nofp-unchecked', fingerprint: undefined, checked: false },
    ]);
    expect([...byRepo]).toEqual([
      ['/a', { reviewed: [{ path: 'x', fingerprint: 'f1' }], unreviewed: [{ path: 'y', fingerprint: 'f2' }] }],
      ['/b', { reviewed: [{ path: 'z', fingerprint: 'f3' }], unreviewed: [] }],
    ]);
    expect(unmarkable).toEqual(['nofp']);
  });

  it('is empty for no toggles', () => {
    expect(groupReviewToggles([])).toEqual({ byRepo: new Map(), unmarkable: [] });
  });
});
