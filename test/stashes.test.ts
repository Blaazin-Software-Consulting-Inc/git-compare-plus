import { describe, expect, it, vi } from 'vitest';
import type { ChangedFile, StashEntry } from '../src/git/parsers';
import { dropConfirmation, stashDescription, stashFiles, stashLabel, stashTooltip, type StashPort } from '../src/stashes';

const NOW = Date.UTC(2026, 9, 22, 12);
const stash = (overrides: Partial<StashEntry> = {}): StashEntry => ({
  ref: 'stash@{0}',
  sha: 'stashsha',
  parents: ['base', 'index'],
  createdAt: NOW - 2 * 3_600_000,
  branch: 'main',
  message: 'my work',
  named: true,
  ...overrides,
});
const file = (path: string, status: ChangedFile['status'] = 'modified'): ChangedFile => ({ status, path, oldPath: path });

function port(): { [K in keyof StashPort]: ReturnType<typeof vi.fn> & StashPort[K] } {
  return {
    diffNameStatus: vi.fn(async (_cwd: string, from: string) => (from === 'empty' ? [file('new.txt', 'added')] : [file('z.ts'), file('a.ts')])),
    diffNumstat: vi.fn(async (_cwd: string, from: string) => new Map([[from === 'empty' ? 'new.txt' : 'a.ts', { added: 2, deleted: 1, binary: false }]])),
    emptyTree: vi.fn(async () => 'empty'),
  };
}

describe('stashFiles', () => {
  it('lists tracked changes (made-on commit → stash), sorted, with line counts', async () => {
    const git = port();
    const files = await stashFiles(git, '/r', stash());
    expect(git.diffNameStatus).toHaveBeenCalledWith('/r', 'base', 'stashsha');
    expect(git.emptyTree).not.toHaveBeenCalled();
    expect(files.map((f) => [f.file.path, f.leftRevision, f.rightRevision, f.file.lines?.added])).toEqual([
      ['a.ts', 'base', 'stashsha', 2],
      ['z.ts', 'base', 'stashsha', undefined],
    ]);
  });

  it('adds the untracked files saved with --include-untracked, as untracked, read from that commit', async () => {
    const git = port();
    const files = await stashFiles(git, '/r', stash({ parents: ['base', 'index', 'untrackedsha'] }));
    expect(git.diffNameStatus).toHaveBeenCalledWith('/r', 'empty', 'untrackedsha');
    expect(files.at(-1)).toMatchObject({ file: { path: 'new.txt', status: 'untracked', lines: { added: 2 } }, rightRevision: 'untrackedsha' });
    // No left side: the file did not exist before the stash.
    expect(files.at(-1)?.leftRevision).toBeUndefined();
  });
});

describe('stash wording', () => {
  it('labels named stashes by message and unnamed ones by branch', () => {
    expect(stashLabel(stash())).toBe('my work');
    expect(stashLabel(stash({ named: false, message: 'abc1234 init' }))).toBe('Uncommitted changes on main');
    expect(stashLabel(stash({ named: false, branch: undefined }))).toBe('Uncommitted changes on a detached commit');
  });

  it('describes ref, branch and age', () => {
    expect(stashDescription(stash(), NOW)).toBe('stash@{0} · on main · 2 h ago');
    expect(stashDescription(stash({ branch: undefined }), NOW)).toBe('stash@{0} · 2 h ago');
  });

  it('says in the hover what Apply, Pop and Drop do, and when untracked files are included', () => {
    expect(stashTooltip(stash())).toContain('Apply keeps the stash; Pop applies it and removes it; Drop deletes it.');
    expect(stashTooltip(stash({ parents: ['a', 'b', 'c'] }))).toContain('Includes untracked files.');
    expect(stashTooltip(stash({ named: false, message: 'abc1234 init' }))).toContain('Made on abc1234 init');
  });

  it('confirms Drop with what is lost', () => {
    expect(dropConfirmation(stash(), 3)).toMatchObject({ title: 'Drop stash "my work"?', confirm: 'Drop Stash', detail: expect.stringContaining('3 changed files in it will be deleted') });
    expect(dropConfirmation(stash(), 1).detail).toContain('1 changed file in it');
  });
});
