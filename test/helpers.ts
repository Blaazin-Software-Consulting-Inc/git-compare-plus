/**
 * Shared test doubles: a logger that records calls, and a fake `ComparisonPort` whose answers
 * each test overrides; and `gitStylePath` for integration tests that compare paths git printed.
 */
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { vi } from 'vitest';
import type { ComparisonPort, RepoInfo } from '../src/comparison';
import type { Logger } from '../src/logger';

type Level = 'debug' | 'info' | 'warn' | 'error';

export function recordingLogger(): Logger & { calls: Record<Level, unknown[][]> } {
  const calls: Record<Level, unknown[][]> = { debug: [], info: [], warn: [], error: [] };
  return {
    calls,
    debug: (...args) => calls.debug.push(args),
    info: (...args) => calls.info.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
  };
}

/**
 * A temp folder's path as git prints it, so integration tests can compare it with git's output:
 * fully resolved (macOS `/var` → `/private/var`; Windows long names, not `RUNNER~1`) and with
 * forward slashes on Windows. Join further segments with `path.posix.join` to keep that form.
 */
export function gitStylePath(folder: string): string {
  return realpathSync.native(folder).split(path.sep).join('/');
}

export function repo(name: string): RepoInfo {
  return { name, root: `/ws/${name}`, commonDir: `/ws/${name}/.git` };
}

/**
 * A port where every repo has `origin/master`, merge base `mb` (on no branch: isAncestor is
 * false), every revision resolves to
 * `sha:<rev>`, snapshots are `tree:<root>`, nothing is uncommitted, and there are no changes
 * (so no line stats either).
 */
export function fakePort(overrides: Partial<ComparisonPort> = {}): { [K in keyof ComparisonPort]: ReturnType<typeof vi.fn> & ComparisonPort[K] } {
  return {
    defaultBranch: vi.fn(async () => 'origin/master'),
    mergeBase: vi.fn(async () => 'mb'),
    isAncestor: vi.fn(async () => false),
    resolveCommit: vi.fn(async (_cwd: string, revision: string) => `sha:${revision}`),
    diffNameStatus: vi.fn(async () => []),
    diffNumstat: vi.fn(async () => new Map()),
    commitsBetween: vi.fn(async () => []),
    untrackedLineStats: vi.fn(async () => new Map()),
    blobIds: vi.fn(async () => new Map()),
    hashWorkingFiles: vi.fn(async () => new Map()),
    untracked: vi.fn(async () => []),
    uncommittedCount: vi.fn(async () => 0),
    uncommittedPaths: vi.fn(async () => new Map()),
    snapshotWorktree: vi.fn(async (root: string) => `tree:${root}`),
    ...overrides,
  } as { [K in keyof ComparisonPort]: ReturnType<typeof vi.fn> & ComparisonPort[K] };
}
