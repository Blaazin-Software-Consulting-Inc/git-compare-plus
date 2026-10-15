import { describe, expect, it } from 'vitest';
import { BaseStore, baseLabel, baseMatches, isBaseSpec, type KeyValueStore } from '../src/baseStore';

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

describe('BaseStore', () => {
  it('sets, reads and clears a base per repo without touching other repos', async () => {
    const store = new BaseStore(memoryStore());
    await store.set('/a/.git', { kind: 'ref', ref: 'release' });
    await store.set('/b/.git', { kind: 'worktree', root: '/b/wt', label: 'wt', includeUncommitted: true });

    expect(store.get('/a/.git')).toEqual({ kind: 'ref', ref: 'release' });
    await store.clear('/a/.git');
    expect(store.get('/a/.git')).toBeUndefined();
    expect(store.get('/b/.git')).toMatchObject({ kind: 'worktree', root: '/b/wt' });
  });

  it('treats setting the default as clearing', async () => {
    const backing = memoryStore();
    const store = new BaseStore(backing);
    await store.set('/a/.git', { kind: 'ref', ref: 'x' });
    await store.set('/a/.git', { kind: 'default' });
    expect(store.get('/a/.git')).toBeUndefined();
  });

  it('ignores malformed persisted data instead of throwing', () => {
    const store = new BaseStore(memoryStore({ 'branchCompare.basesByRepo': { '/a/.git': { kind: 'worktree', root: 1 } } }));
    expect(store.get('/a/.git')).toBeUndefined();
    expect(new BaseStore(memoryStore({ 'branchCompare.basesByRepo': 'garbage' })).get('/a/.git')).toBeUndefined();
  });
});

describe('isBaseSpec', () => {
  it('accepts each valid shape and rejects others', () => {
    expect(isBaseSpec({ kind: 'default' })).toBe(true);
    expect(isBaseSpec({ kind: 'ref', ref: 'main' })).toBe(true);
    expect(isBaseSpec({ kind: 'worktree', root: '/w', label: 'w', includeUncommitted: false })).toBe(true);
    expect(isBaseSpec({ kind: 'ref' })).toBe(false);
    expect(isBaseSpec({ kind: 'other' })).toBe(false);
    expect(isBaseSpec(null)).toBe(false);
  });
});

describe('baseMatches / baseLabel', () => {
  it('matches worktrees by path and branches by name', () => {
    const wt = { kind: 'worktree' as const, root: '/w', label: 'w', includeUncommitted: true };
    expect(baseMatches(wt, { worktreeRoot: '/w' })).toBe(true);
    expect(baseMatches(wt, { ref: 'w' })).toBe(false);
    expect(baseMatches({ kind: 'ref', ref: 'main' }, { ref: 'main' })).toBe(true);
    expect(baseMatches(undefined, { ref: 'main' })).toBe(false);
  });

  it('labels say whether uncommitted edits are included', () => {
    expect(baseLabel({ kind: 'worktree', root: '/w', label: 'w', includeUncommitted: true })).toBe('w (worktree + uncommitted)');
    expect(baseLabel({ kind: 'worktree', root: '/w', label: 'w', includeUncommitted: false })).toBe('w (worktree, committed)');
    expect(baseLabel({ kind: 'default' })).toBe('default branch');
  });
});
