import { describe, expect, it, vi } from 'vitest';
import {
  aheadBehindBase,
  aheadBehindText,
  aheadBehindTooltip,
  loadAheadBehind,
  worktreeAheadBehind,
  type AheadBehindPort,
} from '../src/aheadBehind';
import type { RefEntry, WorktreeEntry } from '../src/git/parsers';
import { recordingLogger } from './helpers';

const ref = (name: string, kind: 'local' | 'remote' = 'local'): RefEntry => ({ name, kind, sha: name, isHead: false });
const wt = (path: string, branch: string | undefined, head = `sha-${path}`): WorktreeEntry => ({ path, branch, head, detached: branch === undefined, bare: false, prunable: false });
const BASE = { label: 'origin/main', commitish: 'origin/main' };

function port(overrides: Partial<AheadBehindPort> = {}): { [K in keyof AheadBehindPort]: ReturnType<typeof vi.fn> & AheadBehindPort[K] } {
  return {
    resolveCommit: vi.fn(async () => 'basesha'),
    aheadBehindAllRefs: vi.fn(async () => new Map([['feature', { ahead: 2, behind: 5 }]])),
    aheadBehind: vi.fn(async (_cwd: string, _base: string, revision: string) => ({ ahead: revision.length, behind: 1 })),
    ...overrides,
  } as { [K in keyof AheadBehindPort]: ReturnType<typeof vi.fn> & AheadBehindPort[K] };
}

describe('aheadBehindBase', () => {
  const worktrees = [wt('/repo', 'main', 'mainsha'), wt('/repo/.wt/x', 'x', 'xsha')];

  it('uses the default branch when no base is set', () => {
    expect(aheadBehindBase(undefined, 'origin/master', worktrees)).toEqual({ label: 'origin/master', commitish: 'origin/master' });
    expect(aheadBehindBase({ kind: 'default' }, undefined, worktrees)).toBeUndefined();
  });

  it('uses a ref base by name and a worktree base by its HEAD commit', () => {
    expect(aheadBehindBase({ kind: 'ref', ref: 'release' }, 'origin/main', worktrees)).toEqual({ label: 'release', commitish: 'release' });
    expect(aheadBehindBase({ kind: 'worktree', root: '/repo/.wt/x', label: 'x', includeUncommitted: true }, 'origin/main', worktrees)).toEqual({ label: 'x', commitish: 'xsha' });
  });

  it('is undefined when a worktree base no longer exists', () => {
    expect(aheadBehindBase({ kind: 'worktree', root: '/gone', label: 'g', includeUncommitted: false }, 'origin/main', worktrees)).toBeUndefined();
  });
});

describe('loadAheadBehind', () => {
  it('counts every branch in one call against the resolved base SHA, and detached worktrees by commit', async () => {
    const git = port();
    const counts = await loadAheadBehind(git, '/repo', BASE, [ref('feature')], [wt('/repo', 'main'), wt('/d', undefined, 'detsha')], recordingLogger());
    expect(git.resolveCommit).toHaveBeenCalledWith('/repo', 'origin/main');
    expect(git.aheadBehindAllRefs).toHaveBeenCalledWith('/repo', 'basesha');
    expect(git.aheadBehind).toHaveBeenCalledTimes(1);
    expect(git.aheadBehind).toHaveBeenCalledWith('/repo', 'basesha', 'detsha');
    expect(counts?.byRef.get('feature')).toEqual({ ahead: 2, behind: 5 });
    expect(counts?.byCommit.get('detsha')).toEqual({ ahead: 6, behind: 1 });
    expect(counts?.baseLabel).toBe('origin/main');
  });

  it('falls back to one count per LOCAL branch when git lacks %(ahead-behind)', async () => {
    const git = port({ aheadBehindAllRefs: vi.fn(async () => undefined) });
    const counts = await loadAheadBehind(git, '/repo', BASE, [ref('a'), ref('bb'), ref('origin/a', 'remote')], [], recordingLogger());
    expect(git.aheadBehind.mock.calls.map((c) => c[2])).toEqual(['a', 'bb']);
    expect([...(counts?.byRef.keys() ?? [])]).toEqual(['a', 'bb']);
  });

  it('runs the fallback in small batches, not all at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const git = port({
      aheadBehindAllRefs: vi.fn(async () => undefined),
      aheadBehind: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return { ahead: 0, behind: 0 };
      }),
    });
    await loadAheadBehind(git, '/repo', BASE, Array.from({ length: 10 }, (_, i) => ref(`b${i}`)), [], recordingLogger());
    expect(git.aheadBehind).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('is undefined (no git walk) when the base does not resolve', async () => {
    const git = port({ resolveCommit: vi.fn(async () => undefined) });
    expect(await loadAheadBehind(git, '/repo', BASE, [ref('feature')], [], recordingLogger())).toBeUndefined();
    expect(git.aheadBehindAllRefs).not.toHaveBeenCalled();
  });

  it('logs WARN and returns undefined instead of throwing when git fails', async () => {
    const logger = recordingLogger();
    const git = port({
      aheadBehindAllRefs: vi.fn(async () => {
        throw new Error('index.lock');
      }),
    });
    expect(await loadAheadBehind(git, '/repo', BASE, [], [], logger)).toBeUndefined();
    expect(logger.calls.warn).toEqual([[expect.stringContaining('ahead/behind counts unavailable'), expect.objectContaining({ reason: 'index.lock' })]]);
  });
});

describe('worktreeAheadBehind', () => {
  const counts = { baseLabel: 'm', byRef: new Map([['x', { ahead: 1, behind: 0 }]]), byCommit: new Map([['dsha', { ahead: 0, behind: 3 }]]) };

  it('looks a worktree up by branch, or by HEAD when detached', () => {
    expect(worktreeAheadBehind(counts, wt('/a', 'x'))).toEqual({ ahead: 1, behind: 0 });
    expect(worktreeAheadBehind(counts, wt('/b', undefined, 'dsha'))).toEqual({ ahead: 0, behind: 3 });
    expect(worktreeAheadBehind(counts, wt('/c', 'unknown'))).toBeUndefined();
    expect(worktreeAheadBehind(undefined, wt('/a', 'x'))).toBeUndefined();
  });
});

describe('aheadBehindText / aheadBehindTooltip', () => {
  it('shows only the non-zero sides, and nothing when even or unknown', () => {
    expect(aheadBehindText({ ahead: 3, behind: 12 })).toBe('↑3 ↓12');
    expect(aheadBehindText({ ahead: 3, behind: 0 })).toBe('↑3');
    expect(aheadBehindText({ ahead: 0, behind: 12 })).toBe('↓12');
    expect(aheadBehindText({ ahead: 0, behind: 0 })).toBe('');
    expect(aheadBehindText(undefined)).toBe('');
  });

  it('spells out the counts and the base', () => {
    expect(aheadBehindTooltip({ ahead: 1, behind: 12 }, 'origin/master')).toBe('1 commit ahead of origin/master, 12 behind');
    expect(aheadBehindTooltip({ ahead: 2, behind: 0 }, 'x')).toBe('2 commits ahead of x, 0 behind');
    expect(aheadBehindTooltip({ ahead: 0, behind: 0 }, 'x')).toBe('Even with x');
    expect(aheadBehindTooltip(undefined, 'x')).toBeUndefined();
  });
});
