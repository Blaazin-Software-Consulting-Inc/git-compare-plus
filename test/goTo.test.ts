import { describe, expect, it } from 'vitest';
import type { RefEntry, WorktreeEntry } from '../src/git/parsers';
import { goToEntries, statusText, windowWorktree } from '../src/goTo';
import { repo } from './helpers';

const wt = (p: string, branch?: string): WorktreeEntry => ({ path: p, branch, head: 'abcdef0', detached: branch === undefined, bare: false, prunable: false });
const ref = (name: string, kind: 'local' | 'remote' = 'local'): RefEntry => ({ name, kind, sha: 'abc', isHead: false });
const svc = repo('svc');
const worktrees = [wt('/ws/svc', 'main'), wt('/ws/svc/.wt/x', 'feature-x')];

describe('goToEntries', () => {
  it("lists this window's worktree first, then other worktrees, local branches, remote branches", () => {
    const entries = goToEntries(svc, worktrees, [ref('origin/main', 'remote'), ref('main'), ref('old')], ['/ws/svc/.wt/x']);
    expect(entries.map((e) => [e.kind, e.label, e.outcome])).toEqual([
      ['worktree', 'feature-x', 'this window'],
      ['worktree', 'main', 'opens in a new window'],
      ['branch', 'main', 'opens repo folder in a new window'],
      ['branch', 'old', 'not checked out: switch to it or create a worktree'],
      ['branch', 'origin/main', 'opens repo folder in a new window'],
    ]);
  });

  it('says a remote branch without a local copy will create one', () => {
    const [entry] = goToEntries(svc, [], [ref('origin/new', 'remote')], []);
    expect(entry?.outcome).toBe('not checked out: switch to it or create a worktree (creates new)');
  });
});

describe('windowWorktree', () => {
  const candidates = [{ repo: svc, worktrees }];

  it('picks the worktree holding the active file, deepest first (linked worktrees can sit inside the main one)', () => {
    const folders = ['/ws/svc', '/ws/svc/.wt/x'];
    expect(windowWorktree(candidates, folders, '/ws/svc/.wt/x/src/a.ts')?.worktree.path).toBe('/ws/svc/.wt/x');
    expect(windowWorktree(candidates, folders, '/ws/svc/src/a.ts')?.worktree.path).toBe('/ws/svc');
  });

  it('falls back to the first worktree open in this window, and to nothing', () => {
    expect(windowWorktree(candidates, ['/ws/svc/.wt/x'], '/tmp/other.txt')?.worktree.path).toBe('/ws/svc/.wt/x');
    expect(windowWorktree(candidates, ['/ws/svc/.wt/x'], undefined)?.worktree.path).toBe('/ws/svc/.wt/x');
    expect(windowWorktree(candidates, ['/unrelated'], undefined)).toBeUndefined();
  });
});

describe('statusText', () => {
  it('says repo folder, or the short path of a linked one', () => {
    expect(statusText({ repo: svc, worktree: worktrees[0] as WorktreeEntry })).toBe('repo folder');
    expect(statusText({ repo: svc, worktree: worktrees[1] as WorktreeEntry })).toBe('.wt/x');
  });
});
