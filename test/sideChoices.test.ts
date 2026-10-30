import { describe, expect, it } from 'vitest';
import type { RefEntry, TagEntry, WorktreeEntry } from '../src/git/parsers';
import { SIDE_GROUP_TITLES, preselectedIndex, sideChoices, type SideChoiceInputs } from '../src/sideChoices';

const NOW = Date.UTC(2026, 9, 22);
const HOUR = 3_600_000;
const wt = (path: string, branch?: string): WorktreeEntry => ({ path, branch, head: `sha-${path}`, detached: branch === undefined, bare: false, prunable: false });
const ref = (name: string, kind: 'local' | 'remote' = 'local'): RefEntry => ({ name, kind, sha: name, isHead: false, committedAt: NOW - 2 * HOUR });
const tag = (name: string): TagEntry => ({ name, createdAt: NOW - 24 * HOUR });

function inputs(overrides: Partial<SideChoiceInputs> = {}): SideChoiceInputs {
  return {
    role: 'against',
    repoRoot: '/r',
    worktrees: [wt('/r', 'main'), wt('/r/.wt/x', 'feature-x')],
    refs: [ref('main'), ref('origin/main', 'remote'), ref('feature-x')],
    tags: [tag('v1.0')],
    windowFolders: ['/r/.wt/x'],
    defaultBranch: 'origin/main',
    nowMs: NOW,
    ...overrides,
  };
}

const groups = (choices: ReturnType<typeof sideChoices>) => [...new Set(choices.map((c) => c.group))];

describe('sideChoices', () => {
  it('lists the groups in one fixed order, Suggested first for Against', () => {
    expect(groups(sideChoices(inputs()))).toEqual(['suggested', 'window', 'worktrees', 'branches', 'remotes', 'tags', 'commits']);
    expect(Object.keys(SIDE_GROUP_TITLES)).toEqual(['suggested', 'window', 'worktrees', 'branches', 'remotes', 'tags', 'commits']);
  });

  it('has no Suggested group when picking what to review', () => {
    expect(groups(sideChoices(inputs({ role: 'review' })))[0]).toBe('window');
  });

  it('puts worktrees open in this window under This window, matching paths loosely', () => {
    const choices = sideChoices(inputs({ windowFolders: ['/r/.wt/x/'] }));
    expect(choices.filter((c) => c.group === 'window').map((c) => c.label)).toEqual(['feature-x']);
    expect(choices.find((c) => c.label === 'main' && c.group === 'worktrees')?.description).toBe('worktree · repo folder');
  });

  it('describes worktrees, branches with age, and tags with ref kinds', () => {
    const choices = sideChoices(inputs());
    expect(choices.find((c) => c.group === 'window')?.description).toBe('worktree · .wt/x');
    expect(choices.find((c) => c.group === 'remotes')).toMatchObject({ label: 'origin/main', description: '2 h ago', value: { kind: 'ref', refKind: 'remote' } });
    expect(choices.find((c) => c.group === 'tags')).toMatchObject({ label: 'v1.0', icon: 'tag', value: { kind: 'ref', ref: 'v1.0', refKind: 'tag' } });
    expect(choices.at(-1)).toMatchObject({ group: 'commits', value: { kind: 'searchCommits' } });
  });

  it('offers the saved default Against before the default branch, naming both', () => {
    const choices = sideChoices(inputs({ storedBase: { kind: 'ref', ref: 'release', refKind: 'branch' } }));
    expect(choices.slice(0, 2).map((c) => [c.label, c.description])).toEqual([
      ["This repo's default Against", 'release'],
      ['Default branch', 'origin/main'],
    ]);
  });

  it('leaves out the side already being reviewed', () => {
    const fromWorktree = sideChoices(inputs({ reviewing: { kind: 'worktree', root: '/r/.wt/x', label: 'feature-x', includeUncommitted: true } }));
    expect(fromWorktree.some((c) => c.value.kind === 'worktree' && c.value.worktree.path === '/r/.wt/x')).toBe(false);
    // The branch of that worktree is still offered: comparing a worktree's edits with its own branch is useful.
    expect(fromWorktree.some((c) => c.label === 'feature-x' && c.group === 'branches')).toBe(true);

    const fromBranch = sideChoices(inputs({ reviewing: { kind: 'ref', ref: 'feature-x', label: 'feature-x' } }));
    expect(fromBranch.some((c) => c.group === 'branches' && c.label === 'feature-x')).toBe(false);
  });

  it('labels a detached worktree by its commit', () => {
    const choices = sideChoices(inputs({ worktrees: [wt('/r', 'main'), { ...wt('/r/d'), head: 'abcdef0123' }], windowFolders: [] }));
    expect(choices.some((c) => c.label === 'detached @ abcdef0')).toBe(true);
  });
});

describe('preselectedIndex', () => {
  it('highlights the default branch for Against and this window for Review', () => {
    const against = sideChoices(inputs({ storedBase: { kind: 'ref', ref: 'release' } }));
    expect(against[preselectedIndex(against, 'against')]?.label).toBe('Default branch');
    const review = sideChoices(inputs({ role: 'review' }));
    expect(review[preselectedIndex(review, 'review')]?.label).toBe('feature-x');
  });

  it('falls back to the first choice', () => {
    const review = sideChoices(inputs({ role: 'review', windowFolders: [] }));
    expect(preselectedIndex(review, 'review')).toBe(0);
  });
});
