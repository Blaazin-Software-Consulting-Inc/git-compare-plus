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

  it('keeps those rules when the file is both committed and uncommitted (`.both` suffix)', () => {
    const both = (command: string) => statuses.filter((status) => shown(command, `changedFile.${status}.both`));
    expect(both('gitComparePlus.openFile')).toEqual(['added', 'untracked', 'modified', 'renamed']);
    expect(both('gitComparePlus.openFileAtBase')).toEqual(['modified', 'renamed', 'deleted']);
  });

  it.each(['gitComparePlus.openCommittedChange', 'gitComparePlus.openUncommittedChange'])('%s is offered only on files with both parts', (command) => {
    expect(statuses.filter((status) => shown(command, `changedFile.${status}.both`))).toEqual([...statuses]);
    expect(shownFor(command)).toEqual([]);
    expect(shown(command, 'commit')).toBe(false);
    expect(shown(command, 'commitsFile')).toBe(false);
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

describe('Review in Changes (removed: a click on a row now shows it in Changes)', () => {
  it('is no longer contributed', () => {
    expect(pkg.contributes.commands.some((c) => c.command === 'gitComparePlus.commits.reviewBranch')).toBe(false);
  });
});

describe('Comparing with something other than the default Against', () => {
  const inline = (view: string) => pkg.contributes.menus['view/item/context'].filter((e) => e.group?.startsWith('inline') && e.when.includes(`view == ${view}`));

  it('has a Review Against… button on every comparable row, after the compare button', () => {
    const entry = inline('gitComparePlus.repositories').find((e) => e.command === 'gitComparePlus.compareWith');
    expect(entry?.group).toBe('inline@2');
    expect(shown('gitComparePlus.compareWith', values.linkedWorktree)).toBe(true);
    expect(shown('gitComparePlus.compareWith', values.remoteBranch)).toBe(true);
    expect(pkg.contributes.commands.find((c) => c.command === 'gitComparePlus.compareWith')?.icon).toBeDefined();
  });

  it('offers Use as Against on worktree and branch rows only while Changes shows a comparison, one row at a time', () => {
    const entry = pkg.contributes.menus['view/item/context'].find((e) => e.command === 'gitComparePlus.useAsAgainst');
    expect(entry?.when).toContain('gitComparePlus.hasComparison');
    expect(entry?.when).toContain('!listMultiSelection');
    expect(shown('gitComparePlus.useAsAgainst', values.localBranch)).toBe(true);
    expect(shown('gitComparePlus.useAsAgainst', values.linkedWorktree)).toBe(true);
    expect(shown('gitComparePlus.useAsAgainst', values.repo)).toBe(false);
    expect(pkg.contributes.menus['commandPalette']?.find((e) => e.command === 'gitComparePlus.useAsAgainst')?.when).toBe('false');
  });

  it("puts a pick button on the Changes Against row, like the Reviewing row's", () => {
    const pick = inline('gitComparePlus.changes').find((e) => e.command === 'gitComparePlus.changeBase');
    expect(pick?.group).toBe('inline@1');
    expect(pick?.when).toContain('header\\.base');
  });
});

describe('Compare These Two (Repositories multi-selection)', () => {
  it('is on worktree and branch rows, not repo rows', () => {
    for (const value of ['mainWorktree', 'linkedWorktree', 'linkedWorktreeBase', 'localBranch', 'localCheckedOut', 'localBase', 'remoteBranch'] as const) {
      expect(shown('gitComparePlus.compareSelected', values[value])).toBe(true);
    }
    expect(shown('gitComparePlus.compareSelected', values.repo)).toBe(false);
    expect(shown('gitComparePlus.compareSelected', values.repoWithBase)).toBe(false);
    expect(shown('gitComparePlus.compareSelected', 'stash')).toBe(false);
  });

  it('appears only with several rows selected, and not in the Command Palette', () => {
    const entries = pkg.contributes.menus['view/item/context'].filter((e) => e.command === 'gitComparePlus.compareSelected');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.when.includes('listMultiSelection') && e.when.includes('view == gitComparePlus.repositories'))).toBe(true);
    expect(pkg.contributes.menus['commandPalette']?.find((e) => e.command === 'gitComparePlus.compareSelected')?.when).toBe('false');
  });
});
