import { describe, expect, it } from 'vitest';
import type { BaseSpec, ComparisonResult, Subject } from '../src/comparison';
import { describeHeader, sidesSummary, type ComparisonSetup } from '../src/views/changesHeader';
import { repo } from './helpers';

const wt = (includeUncommitted: boolean): Subject => ({ kind: 'worktree', root: '/wt', label: 'feature-x', includeUncommitted });

function result(subject: Subject, overrides: Partial<ComparisonResult> = {}): ComparisonResult {
  return { repo: repo('svc'), subject, outcome: 'compared', mode: 'merge-base', baseLabel: 'origin/master', excludedUncommitted: {}, files: [], ...overrides };
}

function header(subject: Subject, base: BaseSpec, overrides: Partial<ComparisonResult> = {}, mode: 'merge-base' | 'direct' = 'merge-base') {
  const setup: ComparisonSetup = { requests: [{ repo: repo('svc'), subject }], base, mode };
  const [subjectRow, baseRow, modeRow] = describeHeader(setup, [result(subject, overrides)]);
  return { subjectRow, baseRow, modeRow };
}

describe('subject row', () => {
  it('says INCLUDING uncommitted edits and toggles on click', () => {
    const { subjectRow } = header(wt(true), { kind: 'default' });
    expect(subjectRow).toMatchObject({
      label: 'Reviewing: feature-x',
      description: 'worktree · INCLUDING uncommitted edits',
      warning: false,
      command: 'gitComparePlus.toggleUncommitted',
    });
  });

  it('counts the files with uncommitted edits (marked ✎) when there are any', () => {
    const edited = { status: 'modified' as const, path: 'a.ts', oldPath: 'a.ts', origin: { committed: false, uncommitted: { staged: false, unstaged: true, untracked: false } } };
    const committed = { status: 'modified' as const, path: 'b.ts', oldPath: 'b.ts', origin: { committed: true } };
    expect(header(wt(true), { kind: 'default' }, { files: [edited, committed] }).subjectRow?.description).toBe('worktree · INCLUDING uncommitted edits · ✎ 1 file');
    expect(header(wt(true), { kind: 'default' }, { files: [committed] }).subjectRow?.description).toBe('worktree · INCLUDING uncommitted edits');
  });

  it('warns with a count when committed only and edits exist', () => {
    const { subjectRow } = header(wt(false), { kind: 'default' }, { excludedUncommitted: { subject: 3 } });
    expect(subjectRow).toMatchObject({ description: 'worktree · committed only · 3 uncommitted files NOT included', warning: true, icon: 'warning' });
  });

  it('does not warn when committed only and nothing is uncommitted', () => {
    const { subjectRow } = header(wt(false), { kind: 'default' }, { excludedUncommitted: { subject: 0 } });
    expect(subjectRow).toMatchObject({ description: 'worktree · committed only', warning: false });
  });

  it('a branch has nothing to toggle', () => {
    const { subjectRow } = header({ kind: 'ref', ref: 'feat', label: 'feat', refKind: 'branch' }, { kind: 'default' });
    expect(subjectRow).toMatchObject({ description: 'branch · committed work', icon: 'git-branch' });
    expect(subjectRow?.command).toBeUndefined();
  });

  it('names tags, commits and remote branches, and plain "ref" when the kind is unknown', () => {
    const subject = (refKind?: 'tag' | 'commit' | 'remote') => header({ kind: 'ref', ref: 'x', label: 'x', refKind }, { kind: 'default' }).subjectRow;
    expect(subject('tag')).toMatchObject({ description: 'tag · committed work', icon: 'tag' });
    expect(subject('commit')).toMatchObject({ description: 'commit · committed work', icon: 'git-commit' });
    expect(subject('remote')).toMatchObject({ description: 'remote branch · committed work', icon: 'cloud' });
    expect(subject()).toMatchObject({ description: 'ref · committed work' });
  });

  it('says which side of the diff each row is', () => {
    const { subjectRow, baseRow } = header(wt(true), { kind: 'default' });
    expect(subjectRow?.tooltip).toContain('right side of every diff');
    expect(baseRow?.tooltip).toContain('left side of every diff');
  });

  it('labels a commit base by its title rather than its SHA', () => {
    const { baseRow } = header(wt(true), { kind: 'ref', ref: 'abcdef0123', refKind: 'commit', label: 'abcdef0 Fix login' });
    expect(baseRow).toMatchObject({ label: 'Against: abcdef0 Fix login', description: 'commit · click to change' });
  });

  it('sums excluded files across repos and says how many repos', () => {
    const setup: ComparisonSetup = {
      requests: [
        { repo: repo('a'), subject: wt(false) },
        { repo: repo('b'), subject: wt(false) },
      ],
      base: { kind: 'default' },
      mode: 'merge-base',
    };
    const [subjectRow] = describeHeader(setup, [
      result(wt(false), { excludedUncommitted: { subject: 1 } }),
      result(wt(false), { excludedUncommitted: { subject: 2 } }),
    ]);
    expect(subjectRow).toMatchObject({ label: 'Reviewing: 2 repos (main worktrees)', description: 'committed only · 3 uncommitted files NOT included' });
  });
});

describe('base row', () => {
  it('shows the resolved default branch and is clickable', () => {
    expect(header(wt(true), { kind: 'default' }).baseRow).toMatchObject({
      label: 'Against: origin/master',
      description: 'default branch · click to change',
      command: 'gitComparePlus.changeBase',
    });
  });

  it('a committed-only worktree base warns about its excluded edits (singular)', () => {
    const { baseRow } = header(wt(true), { kind: 'worktree', root: '/o', label: 'other', includeUncommitted: false }, { excludedUncommitted: { base: 1 } });
    expect(baseRow).toMatchObject({ label: 'Against: other', description: 'worktree · committed only · 1 uncommitted file NOT included · click to change', warning: true });
  });

  it('a worktree base including edits says so', () => {
    const { baseRow } = header(wt(true), { kind: 'worktree', root: '/o', label: 'other', includeUncommitted: true });
    expect(baseRow?.description).toBe('worktree · INCLUDING its uncommitted edits · click to change');
  });
});

describe('mode row', () => {
  it('describes both modes and toggles', () => {
    expect(header(wt(true), { kind: 'default' }, {}, 'merge-base').modeRow).toMatchObject({ label: 'Showing: changes since branch point', command: 'gitComparePlus.toggleMode' });
    expect(header(wt(true), { kind: 'default' }, {}, 'direct').modeRow).toMatchObject({ label: 'Showing: all differences' });
  });

  const other: BaseSpec = { kind: 'worktree', root: '/o', label: 'feature-y', includeUncommitted: false };
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  it('names the branch point and warns when it is on the default branch, not the Against side', () => {
    const { modeRow } = header(wt(true), other, { baseLabel: 'feature-y', baseRevision: sha, branchPoint: { isAgainstTip: false, onDefaultBranch: 'origin/main' } });
    expect(modeRow).toMatchObject({
      label: 'Showing: changes since branch point a1b2c3d',
      description: "on origin/main, not feature-y's latest · click for all differences",
      icon: 'warning',
      warning: true,
      command: 'gitComparePlus.toggleMode',
    });
    expect(modeRow?.tooltip).toContain('roughly "against origin/main", not against feature-y');
  });

  it('says when the branch point is the tip of the Against side', () => {
    const { modeRow } = header(wt(true), { kind: 'default' }, { baseRevision: sha, branchPoint: { isAgainstTip: true } });
    expect(modeRow).toMatchObject({ label: 'Showing: changes since branch point a1b2c3d', description: 'the tip of origin/master · click for all differences', warning: false });
  });

  it('otherwise says where it split from the Against side', () => {
    const { modeRow } = header(wt(true), { kind: 'default' }, { baseRevision: sha, branchPoint: { isAgainstTip: false } });
    expect(modeRow).toMatchObject({ description: 'where it split from origin/master · click for all differences', icon: 'git-merge', warning: false });
  });

  it('keeps the generic wording for several repos or without branch point details', () => {
    const point = { baseRevision: sha, branchPoint: { isAgainstTip: false, onDefaultBranch: 'origin/main' } };
    const setup: ComparisonSetup = { requests: [{ repo: repo('a'), subject: wt(true) }, { repo: repo('b'), subject: wt(true) }], base: other, mode: 'merge-base' };
    expect(describeHeader(setup, [result(wt(true), point), result(wt(true), point)])[2]).toMatchObject({ label: 'Showing: changes since branch point', warning: false });
    expect(header(wt(true), other, { baseRevision: sha }).modeRow).toMatchObject({ label: 'Showing: changes since branch point', description: 'click for all differences' });
  });

  it('explains why direct is forced for a base with uncommitted edits', () => {
    const { modeRow } = header(wt(true), { kind: 'worktree', root: '/o', label: 'o', includeUncommitted: true }, {}, 'merge-base');
    expect(modeRow).toMatchObject({ label: 'Showing: all differences', description: 'required: the base includes uncommitted edits' });
  });
});

describe('stale fetch warning on the base row', () => {
  const setup: ComparisonSetup = { requests: [{ repo: repo('svc'), subject: wt(true) }], base: { kind: 'default' }, mode: 'merge-base' };

  it('flags a remote base fetched too long ago', () => {
    const [, baseRow] = describeHeader(setup, [result(wt(true))], { age: '3 days ago', stale: true });
    expect(baseRow).toMatchObject({ description: 'default branch · fetched 3 days ago, may be out of date', warning: true, icon: 'warning' });
  });

  it('leaves the row alone when the fetch is recent or the base is local', () => {
    const plain = describeHeader(setup, [result(wt(true))])[1];
    expect(describeHeader(setup, [result(wt(true))], { age: '5 min ago', stale: false })[1]).toEqual(plain);
  });
});

describe('sidesSummary (Changes section header)', () => {
  it('names both sides of a one-repo comparison', () => {
    const setup: ComparisonSetup = { requests: [{ repo: repo('svc'), subject: wt(true) }], base: { kind: 'default' }, mode: 'merge-base' };
    expect(sidesSummary(setup, [result(wt(true))])).toBe('feature-x against origin/master');
  });

  it('uses a ref or worktree base by its label', () => {
    const setup = (base: BaseSpec): ComparisonSetup => ({ requests: [{ repo: repo('svc'), subject: wt(true) }], base, mode: 'direct' });
    expect(sidesSummary(setup({ kind: 'ref', ref: 'abc123', label: 'abc123 Fix', refKind: 'commit' }), [])).toBe('feature-x against abc123 Fix');
    expect(sidesSummary(setup({ kind: 'worktree', root: '/w', label: 'main', includeUncommitted: true }), [])).toBe('feature-x against main');
  });

  it('counts repos, and says "default branches" when they differ', () => {
    const setup: ComparisonSetup = {
      requests: [
        { repo: repo('a'), subject: wt(true) },
        { repo: repo('b'), subject: wt(true) },
      ],
      base: { kind: 'default' },
      mode: 'merge-base',
    };
    expect(sidesSummary(setup, [result(wt(true)), result(wt(true), { baseLabel: 'origin/main' })])).toBe('2 repos against default branches');
  });
});
