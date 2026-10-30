import { describe, expect, it } from 'vitest';
import { branchLocation, branchRows, clickHint, linkedWorktrees, localBranchName, locationText, openChoices, switchTargetFor, worktreeName } from '../src/branchLocation';
import type { RefEntry, WorktreeEntry } from '../src/git/parsers';

const wt = (p: string, branch?: string): WorktreeEntry => ({ path: p, branch, head: 'abc', detached: branch === undefined, bare: false, prunable: false });
const ref = (name: string, kind: 'local' | 'remote' = 'local'): RefEntry => ({ name, kind, sha: 'abc', isHead: false });
const ROOT = '/r';
const worktrees = [wt(ROOT, 'main'), wt('/r/.wt/x', 'feature-x')];

describe('branchLocation', () => {
  it('finds the worktree holding a branch, and whether it is this window', () => {
    expect(branchLocation(ref('feature-x'), worktrees, ['/r/.wt/x'])).toMatchObject({ kind: 'thisWindow', worktree: { path: '/r/.wt/x' } });
    expect(branchLocation(ref('feature-x'), worktrees, [ROOT])).toMatchObject({ kind: 'otherWorktree', worktree: { path: '/r/.wt/x' } });
    expect(branchLocation(ref('other'), worktrees, [ROOT])).toEqual({ kind: 'notCheckedOut' });
  });

  it('places a remote branch where its local copy is', () => {
    expect(localBranchName(ref('origin/feature/a', 'remote'))).toBe('feature/a');
    expect(branchLocation(ref('origin/main', 'remote'), worktrees, [ROOT])).toMatchObject({ kind: 'thisWindow' });
  });
});

describe('branchRows', () => {
  it('lists every local branch in order, like git branch; checked-out ones carry their worktree', () => {
    const refs = [ref('main'), ref('feature-x'), ref('old'), ref('origin/old', 'remote'), ref('newer')];
    const rows = branchRows(refs, worktrees);
    expect(rows.map((r) => [r.ref.name, r.worktree?.path])).toEqual([
      ['main', ROOT],
      ['feature-x', '/r/.wt/x'],
      ['old', undefined],
      ['newer', undefined],
    ]);
    // Not checked out: no worktree key at all, so the row is a plain branch.
    expect('worktree' in (rows[2] ?? {})).toBe(false);
  });

  it('treats every branch as not checked out when all worktrees are detached, and handles no branches', () => {
    expect(branchRows([ref('a'), ref('b')], [wt('/r'), wt('/r/.wt/d')]).map((r) => r.worktree)).toEqual([undefined, undefined]);
    expect(branchRows([], worktrees)).toEqual([]);
  });
});

describe('linkedWorktrees', () => {
  it('leaves out the repo folder (main worktree), and stale or bare entries', () => {
    const stale = { ...wt('/r/.wt/gone', 'gone'), prunable: true };
    expect(linkedWorktrees([wt(ROOT, 'main'), wt('/r/.wt/x', 'feature-x'), stale]).map((w) => w.path)).toEqual(['/r/.wt/x']);
  });

  it('never promotes a linked worktree to main when the main entry is bare', () => {
    const bareMain = { ...wt('/r.git'), bare: true };
    expect(linkedWorktrees([bareMain, wt('/r/.wt/x', 'feature-x')]).map((w) => w.path)).toEqual(['/r/.wt/x']);
  });

  it('is empty for a repo without linked worktrees', () => {
    expect(linkedWorktrees([wt(ROOT, 'main')])).toEqual([]);
    expect(linkedWorktrees([])).toEqual([]);
  });
});

describe('locationText', () => {
  it('says where a local branch lives, and nothing when it is not checked out (its group says so)', () => {
    expect(locationText({ kind: 'thisWindow', worktree: worktrees[0] as WorktreeEntry }, ref('main'), ROOT)).toBe('in this window');
    expect(locationText({ kind: 'otherWorktree', worktree: worktrees[1] as WorktreeEntry }, ref('feature-x'), ROOT)).toBe('in worktree .wt/x');
    expect(locationText({ kind: 'otherWorktree', worktree: worktrees[0] as WorktreeEntry }, ref('main'), ROOT)).toBe('in repo folder');
    expect(locationText({ kind: 'notCheckedOut' }, ref('old'), ROOT)).toBe('');
  });

  it('says "local copy" for remote branches and stays quiet when there is none', () => {
    expect(locationText({ kind: 'thisWindow', worktree: worktrees[0] as WorktreeEntry }, ref('origin/main', 'remote'), ROOT)).toBe('local copy in this window');
    expect(locationText({ kind: 'notCheckedOut' }, ref('origin/x', 'remote'), ROOT)).toBe('');
  });

  it('names worktrees', () => {
    expect(worktreeName(wt(ROOT), ROOT)).toBe('repo folder');
    expect(worktreeName(wt('/r/.wt/x'), ROOT)).toBe('worktree .wt/x');
  });
});

describe('openChoices', () => {
  it('spells out both consequences: switch changes files and never stashes; a worktree leaves work untouched', () => {
    const [switchChoice, createChoice] = openChoices(ref('feature-y'), wt('/r/.wt/x', 'feature-x'), true, ROOT);
    expect(switchChoice).toMatchObject({ action: 'switch', label: '$(arrow-swap) Switch this window to feature-y', worktree: { path: '/r/.wt/x' } });
    expect(switchChoice?.detail).toContain('Changes the files in .wt/x');
    expect(switchChoice?.detail).toContain('nothing is stashed');
    expect(createChoice).toMatchObject({ action: 'createWorktree', label: '$(new-folder) Create a worktree for feature-y' });
    // The suggested folder is a sibling of the repo (operations.ts defaultWorktreePath).
    expect(createChoice?.detail).toContain('r.worktrees/feature-y');
    expect(createChoice?.detail).toContain('Your current work is untouched');
  });

  it('names the repo folder when this window has none of the repo open, and mentions the new local branch for remotes', () => {
    const [switchChoice] = openChoices(ref('origin/feature-z', 'remote'), wt(ROOT, 'main'), false, ROOT);
    expect(switchChoice?.label).toBe('$(arrow-swap) Switch repo folder to feature-z');
    expect(switchChoice?.detail).toContain('Changes the files in the repo folder');
    expect(switchChoice?.detail).toContain('Creates local branch feature-z tracking origin/feature-z');
  });
});

describe('switchTargetFor', () => {
  it("prefers this window's worktree, then the main worktree", () => {
    expect(switchTargetFor(worktrees, ['/r/.wt/x'])).toMatchObject({ worktree: { path: '/r/.wt/x' }, inWindow: true });
    expect(switchTargetFor(worktrees, ['/elsewhere'])).toMatchObject({ worktree: { path: ROOT }, inWindow: false });
    expect(switchTargetFor([], [])).toBeUndefined();
  });
});

describe('clickHint', () => {
  it('says a click reviews it in Changes against the named Against, and how to pick another', () => {
    expect(clickHint('origin/main')).toBe(
      'Click to review it in Changes against origin/main and list its commits in Commits. To compare it with something else: the Review Against… button, or right-click another row → Use as Against.',
    );
  });

  it("falls back to the repo's default Against when it is not known yet", () => {
    expect(clickHint(undefined)).toContain("against the repo's default Against and list");
  });
});
