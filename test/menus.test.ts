/**
 * The context menus are driven by regexes over `contextValue` strings (package.json `when`
 * clauses). This evaluates those regexes against the values repositoriesView.ts produces, so a
 * flag-order change cannot silently hide "Delete Branch" or show it on a checked-out branch.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

interface MenuEntry {
  command: string;
  when: string;
}
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
  contributes: { menus: { 'view/item/context': MenuEntry[] } };
};

/** Every `viewItem =~ /…/` in the command's (non-inline) entry must match. */
function shown(command: string, contextValue: string): boolean {
  const entries = pkg.contributes.menus['view/item/context'].filter((e) => e.command === command);
  return entries.some((entry) =>
    [...entry.when.matchAll(/viewItem =~ \/((?:\\\/|[^/])+)\//g)].every((m) => new RegExp(m[1] ?? '').test(contextValue)),
  );
}

const values = {
  repo: 'comparable.repo',
  repoWithBase: 'comparable.repo.hasBase',
  mainWorktree: 'comparable.worktree.main',
  linkedWorktree: 'comparable.worktree',
  linkedWorktreeBase: 'comparable.worktree.base',
  localBranch: 'comparable.branch.local',
  localCheckedOut: 'comparable.branch.local.checkedOut',
  localBase: 'comparable.branch.local.base',
  remoteBranch: 'comparable.branch.remote',
};

describe('context menu visibility', () => {
  it.each([
    ['branchCompare.deleteBranch', ['localBranch', 'localBase']],
    ['branchCompare.createWorktree', ['localBranch', 'localBase', 'remoteBranch']],
    ['branchCompare.switchBranch', ['localBranch', 'localBase', 'remoteBranch']],
    ['branchCompare.removeWorktree', ['linkedWorktree', 'linkedWorktreeBase']],
    ['branchCompare.openWorktree', ['linkedWorktree', 'linkedWorktreeBase']],
    ['branchCompare.fetch', ['repo', 'repoWithBase']],
    ['branchCompare.setBase', ['mainWorktree', 'linkedWorktree', 'localBranch', 'localCheckedOut', 'remoteBranch']],
    ['branchCompare.clearBase', ['repoWithBase', 'linkedWorktreeBase', 'localBase']],
    ['branchCompare.createBranch', Object.keys(values)],
    ['branchCompare.compare', Object.keys(values)],
  ] as const)('%s is shown exactly for %j', (command, expected) => {
    const actual = Object.entries(values)
      .filter(([, value]) => shown(command, value))
      .map(([name]) => name);
    expect(actual.sort()).toEqual([...expected].sort());
  });
});
