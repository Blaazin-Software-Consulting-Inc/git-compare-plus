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
  contributes: { commands: { command: string }[]; menus: Record<string, MenuEntry[]> & { 'view/item/context': MenuEntry[] } };
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
    ['gitComparePlus.deleteBranch', ['localBranch', 'localBase']],
    ['gitComparePlus.createWorktree', ['localBranch', 'localBase', 'remoteBranch']],
    ['gitComparePlus.switchBranch', ['localBranch', 'localBase', 'remoteBranch']],
    ['gitComparePlus.removeWorktree', ['linkedWorktree', 'linkedWorktreeBase']],
    ['gitComparePlus.openWorktree', ['linkedWorktree', 'linkedWorktreeBase']],
    ['gitComparePlus.fetch', ['repo', 'repoWithBase']],
    ['gitComparePlus.setBase', ['mainWorktree', 'linkedWorktree', 'localBranch', 'localCheckedOut', 'remoteBranch']],
    ['gitComparePlus.clearBase', ['repoWithBase', 'linkedWorktreeBase', 'localBase']],
    ['gitComparePlus.createBranch', Object.keys(values)],
    ['gitComparePlus.compare', Object.keys(values)],
    ['gitComparePlus.openBranch', ['localBranch', 'localCheckedOut', 'localBase', 'remoteBranch']],
    ['gitComparePlus.openInSourceControl', ['mainWorktree', 'linkedWorktree', 'linkedWorktreeBase']],
    ['gitComparePlus.stash.push', ['mainWorktree', 'linkedWorktree', 'linkedWorktreeBase']],
  ] as const)('%s is shown exactly for %j', (command, expected) => {
    const actual = Object.entries(values)
      .filter(([, value]) => shown(command, value))
      .map(([name]) => name);
    expect(actual.sort()).toEqual([...expected].sort());
  });
});

describe('commit context menu (Changes view)', () => {
  it.each(['gitComparePlus.openCommit', 'gitComparePlus.compareWithCommit'])('%s is shown on commits only', (command) => {
    expect(shown(command, 'commit')).toBe(true);
    expect(shown(command, 'changedFile')).toBe(false);
    expect(Object.values(values).some((value) => shown(command, value))).toBe(false);
  });
});

describe('changed-file context menu (Changes view)', () => {
  const statuses = ['added', 'untracked', 'modified', 'renamed', 'deleted'] as const;
  const shownFor = (command: string) => statuses.filter((status) => shown(command, `changedFile.${status}`));

  it('Open File is hidden only for deleted files', () => {
    expect(shownFor('gitComparePlus.openFile')).toEqual(['added', 'untracked', 'modified', 'renamed']);
  });

  it('Open File at Base is hidden for added and untracked files', () => {
    expect(shownFor('gitComparePlus.openFileAtBase')).toEqual(['modified', 'renamed', 'deleted']);
  });

  it('neither appears on commits or Repositories items', () => {
    for (const command of ['gitComparePlus.openFile', 'gitComparePlus.openFileAtBase']) {
      expect(shown(command, 'commit')).toBe(false);
      expect(Object.values(values).some((value) => shown(command, value))).toBe(false);
    }
  });
});

describe('header row buttons (Changes view)', () => {
  it('Change What Is Reviewed is on the Reviewing row only; Swap on both side rows, not the mode row', () => {
    expect(shown('gitComparePlus.changeSubject', 'header.subject')).toBe(true);
    expect(shown('gitComparePlus.changeSubject', 'header.base')).toBe(false);
    expect(shown('gitComparePlus.swapSides', 'header.subject')).toBe(true);
    expect(shown('gitComparePlus.swapSides', 'header.base')).toBe(true);
    expect(shown('gitComparePlus.swapSides', 'header.mode')).toBe(false);
  });

  it('Change Default Against is on repo rows only', () => {
    const actual = Object.entries(values).filter(([, value]) => shown('gitComparePlus.changeDefaultBase', value)).map(([name]) => name);
    expect(actual.sort()).toEqual(['repo', 'repoWithBase']);
  });
});

describe('history commit menu (History view)', () => {
  it.each([
    'gitComparePlus.history.openDiff',
    'gitComparePlus.history.compareWithWorkingTree',
    'gitComparePlus.history.compareWithBranch',
    'gitComparePlus.history.selectForCompare',
    'gitComparePlus.history.compareWithSelected',
    'gitComparePlus.history.compareTwo',
  ])('%s is shown on history commits only', (command) => {
    expect(shown(command, 'historyCommit')).toBe(true);
    expect(shown(command, 'commit')).toBe(false);
    expect(Object.values(values).some((value) => shown(command, value))).toBe(false);
  });
});

describe('shared commit actions (every commit list)', () => {
  const lists = ['commit', 'historyCommit', 'commitsCommit'];

  it.each([
    'gitComparePlus.commit.reviewCommit',
    'gitComparePlus.commit.reviewSince',
    'gitComparePlus.commit.reviewAgainst',
    'gitComparePlus.commit.select',
    'gitComparePlus.commit.compareWithSelected',
    'gitComparePlus.commit.compareTwo',
    'gitComparePlus.commit.copyId',
  ])('%s is on commits in Changes, History and Commits, and nowhere else', (command) => {
    expect(lists.every((value) => shown(command, value))).toBe(true);
    expect(shown(command, 'changedFile.modified')).toBe(false);
    expect(shown(command, 'commitsFile')).toBe(false);
    expect(Object.values(values).some((value) => shown(command, value))).toBe(false);
  });

  it('Show Commit Details is offered where the row is not already in the Commits view', () => {
    expect(shown('gitComparePlus.commit.showDetails', 'commit')).toBe(true);
    expect(shown('gitComparePlus.commit.showDetails', 'historyCommit')).toBe(true);
    expect(shown('gitComparePlus.commit.showDetails', 'commitsCommit')).toBe(false);
  });

  it('every menu entry names a contributed command', () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    const missing = Object.values(pkg.contributes.menus).flat().filter((entry) => !contributed.has(entry.command)).map((entry) => entry.command);
    expect(missing).toEqual([]);
  });
});

describe('stash menu (Repositories view)', () => {
  it.each(['gitComparePlus.stash.openAll', 'gitComparePlus.stash.apply', 'gitComparePlus.stash.pop', 'gitComparePlus.stash.drop'])('%s is on stash rows only', (command) => {
    expect(shown(command, 'stash')).toBe(true);
    expect(Object.values(values).some((value) => shown(command, value))).toBe(false);
    expect(shown(command, 'commit')).toBe(false);
  });
});

describe('Show File History on file rows', () => {
  it('is on changed files in Changes, commit files and stash files, and not on other rows', () => {
    for (const value of ['changedFile.modified', 'changedFile.deleted', 'commitsFile', 'stashFile', 'uncommittedFile']) {
      expect(shown('gitComparePlus.history.showFile', value)).toBe(true);
    }
    for (const value of ['commit', 'historyCommit', 'stash', ...Object.values(values)]) {
      expect(shown('gitComparePlus.history.showFile', value)).toBe(false);
    }
  });
});

describe('History view visibility', () => {
  it('is hidden until Show File History or Show Line History sets gitComparePlus.historyShown', () => {
    const views = (JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
      contributes: { views: Record<string, { id: string; when?: string }[]> };
    }).contributes.views['gitComparePlus'] ?? [];
    expect(views.find((v) => v.id === 'gitComparePlus.history')?.when).toBe('gitComparePlus.historyShown');
    // Shown last, under the sections that are always there.
    expect(views.map((v) => v.id).at(-1)).toBe('gitComparePlus.history');
  });
});

describe('Uncommitted changes row (Commits view)', () => {
  it('Review Uncommitted Changes is on that row only', () => {
    expect(shown('gitComparePlus.commits.reviewUncommitted', 'uncommittedGroup')).toBe(true);
    for (const value of ['commitsCommit', 'uncommittedFile', 'commitsFile', ...Object.values(values)]) {
      expect(shown('gitComparePlus.commits.reviewUncommitted', value)).toBe(false);
    }
  });
});

describe('Review in Changes (Commits view title bar)', () => {
  const entry = pkg.contributes.menus['view/title']?.find((e) => e.command === 'gitComparePlus.commits.reviewBranch');
  // The when clause's regex over gitComparePlus.commitsBranchMode, which commitsView.ts sets to the
  // list mode while a selected worktree or branch is listed and to '' otherwise (search, details).
  const modeRegex = new RegExp(/commitsBranchMode =~ \/((?:\\\/|[^/])+)\//.exec(entry?.when ?? '')?.[1] ?? '^$never');

  it('is in the Commits title bar while a selected worktree or branch is listed, in either mode', () => {
    expect(entry?.when).toContain('view == gitComparePlus.commits');
    expect(modeRegex.test('auto')).toBe(true);
    expect(modeRegex.test('history')).toBe(true);
  });

  it('is hidden for search results, commit details and an empty view (mode unset or empty)', () => {
    expect(modeRegex.test('')).toBe(false);
    expect(modeRegex.test('undefined')).toBe(false);
  });

  it('is not in the Command Palette, where there is no selection to review', () => {
    expect(pkg.contributes.menus['commandPalette']?.find((e) => e.command === 'gitComparePlus.commits.reviewBranch')?.when).toBe('false');
  });
});
