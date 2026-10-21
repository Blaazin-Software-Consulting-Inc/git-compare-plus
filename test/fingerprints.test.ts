import { describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../src/git/parsers';
import { attachFingerprints, type FingerprintPort } from '../src/review/fingerprints';

const file = (status: ChangedFile['status'], path: string, oldPath = path): ChangedFile => ({ status, path, oldPath });

function port(left: Record<string, string>, right: Record<string, string>): { [K in keyof FingerprintPort]: ReturnType<typeof vi.fn> & FingerprintPort[K] } {
  return {
    blobIds: vi.fn(async (_cwd: string, revision: string, paths: readonly string[]) => {
      const source = revision === 'base' ? left : right;
      return new Map(paths.filter((p) => source[p] !== undefined).map((p) => [p, source[p] ?? '']));
    }),
    hashWorkingFiles: vi.fn(async (_root: string, paths: readonly string[]) => new Map(paths.filter((p) => right[p] !== undefined).map((p) => [p, right[p] ?? '']))),
  };
}

describe('attachFingerprints', () => {
  it('pairs the old-path blob on the base with the new-path blob on the subject; "-" for an empty side', async () => {
    const git = port({ 'm.ts': 'L1', 'd.ts': 'L2', 'old.ts': 'L3' }, { 'm.ts': 'R1', 'a.ts': 'R2', 'new.ts': 'R3' });
    const files = await attachFingerprints(git, '/wt', [file('modified', 'm.ts'), file('deleted', 'd.ts'), file('added', 'a.ts'), file('renamed', 'new.ts', 'old.ts')], 'base', 'subject');
    expect(files.map((f) => [f.path, f.fingerprint])).toEqual([
      ['m.ts', 'L1>R1'],
      ['d.ts', 'L2>-'],
      ['a.ts', '->R2'],
      ['new.ts', 'L3>R3'],
    ]);
    // One lookup per side, not per file; deleted files are not looked up on the right.
    expect(git.blobIds).toHaveBeenCalledWith('/wt', 'base', ['m.ts', 'd.ts', 'old.ts']);
    expect(git.blobIds).toHaveBeenCalledWith('/wt', 'subject', ['m.ts', 'a.ts', 'new.ts']);
  });

  it('hashes files on disk when the subject is the working tree (untracked has no left side)', async () => {
    const git = port({ 'm.ts': 'L1' }, { 'm.ts': 'W1', 'u.ts': 'W2' });
    const files = await attachFingerprints(git, '/wt', [file('modified', 'm.ts'), file('untracked', 'u.ts')], 'base', undefined);
    expect(git.hashWorkingFiles).toHaveBeenCalledWith('/wt', ['m.ts', 'u.ts']);
    expect(files.map((f) => f.fingerprint)).toEqual(['L1>W1', '->W2']);
  });

  it('leaves the fingerprint off when an expected side is missing, instead of using "-"', async () => {
    const git = port({}, { 'm.ts': 'R1' });
    const [only] = await attachFingerprints(git, '/wt', [file('modified', 'm.ts')], 'base', 'subject');
    expect(only).toEqual(file('modified', 'm.ts'));
  });

  it('makes no git calls for an empty list', async () => {
    const git = port({}, {});
    expect(await attachFingerprints(git, '/wt', [], 'base', undefined)).toEqual([]);
    expect(git.blobIds).not.toHaveBeenCalled();
    expect(git.hashWorkingFiles).not.toHaveBeenCalled();
  });

  it('propagates git failures to the caller (which degrades to no fingerprints)', async () => {
    const git = port({}, {});
    git.blobIds.mockRejectedValueOnce(new Error('bad revision'));
    await expect(attachFingerprints(git, '/wt', [file('modified', 'm.ts')], 'base', undefined)).rejects.toThrow('bad revision');
  });
});
