/**
 * changesHeader — the three clickable rows at the top of the Changes view that say exactly what
 * is being compared, and let the user change it:
 *
 *   Reviewing: feature-x     worktree · INCLUDING uncommitted edits         (click: toggle)
 *   Against: origin/master   default branch · click to change               (click: pick a side)
 *   Showing: changes since branch point a1b2c3d · on origin/main, not feature-y's latest  (click: toggle mode)
 *
 * The two side names are used everywhere in the UI: "Reviewing" is what changed (the RIGHT side
 * of every diff), "Against" is what it is compared with (the LEFT side). Both rows carry an
 * inline ⇄ button that swaps them (swapSides.ts).
 *
 * The mode row names the branch point when one repo is compared, and flags it when it is on the
 * default branch while the Against side is something else (comparison.ts BranchPoint): the left
 * side is then effectively the default branch, not what the Against row names.
 *
 * Uncommitted edits must never be silently missing, so when a side is "committed only" and the
 * worktree HAS uncommitted files, the row says how many are NOT included and is flagged as a warning.
 *
 * Pure (no `vscode` import) so the wording is unit-tested; changesView.ts renders the rows.
 */
import { uncommittedFileCount } from '../changeOrigin';
import { baseForcesDirect, type BaseSpec, type CompareMode, type ComparisonRequest, type ComparisonResult, type RefKind } from '../comparison';

/** What the user asked for; the Changes view re-runs this when a header row is clicked. */
export interface ComparisonSetup {
  readonly requests: readonly ComparisonRequest[];
  readonly base: BaseSpec;
  readonly mode: CompareMode;
}

/** One header row. `command` is the extension command to run on click, if any. */
export interface HeaderRow {
  readonly role: 'subject' | 'base' | 'mode';
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  /** Codicon name. */
  readonly icon: string;
  readonly warning: boolean;
  readonly command?: 'gitComparePlus.toggleUncommitted' | 'gitComparePlus.changeBase' | 'gitComparePlus.toggleMode';
}

/**
 * Freshness of a remote-tracking base (e.g. `origin/master`): `age` is display text ("3 days ago",
 * "never"), `stale` when older than the `staleFetchHours` setting. Undefined for local bases.
 */
export interface BaseFetchInfo {
  readonly age: string;
  readonly stale: boolean;
}

/**
 * One-line summary of the two sides for the view's title bar, so the section header itself says
 * what Changes is showing: `feature-x against origin/main`, or `3 repos against default branches`.
 * "against", not an arrow: an arrow does not say which side is which.
 */
export function sidesSummary(setup: ComparisonSetup, results: readonly ComparisonResult[]): string {
  const single = setup.requests.length === 1 ? setup.requests[0] : undefined;
  const reviewing = single !== undefined ? single.subject.label : `${setup.requests.length} repos`;
  const labels = [...new Set(results.map((r) => r.baseLabel).filter((l): l is string => l !== undefined))];
  const against =
    setup.base.kind === 'default'
      ? labels.length === 1 && labels[0] !== undefined
        ? labels[0]
        : 'default branches'
      : setup.base.kind === 'ref'
        ? (setup.base.label ?? setup.base.ref)
        : setup.base.label;
  return `${reviewing} against ${against}`;
}

/** Build the header rows for a comparison and its results. */
export function describeHeader(setup: ComparisonSetup, results: readonly ComparisonResult[], baseFetch?: BaseFetchInfo): HeaderRow[] {
  return [subjectRow(setup, results), withFetchWarning(baseRow(setup, results), baseFetch), modeRow(setup, results)];
}

// A stale remote base silently skews every comparison (new commits on origin are missing), so it
// is flagged on the base row itself, where the user is looking.
function withFetchWarning(row: HeaderRow, baseFetch: BaseFetchInfo | undefined): HeaderRow {
  if (baseFetch === undefined || !baseFetch.stale) {
    return row;
  }
  return {
    ...row,
    description: `${row.description.replace(/ · click to change$/, '')} · fetched ${baseFetch.age}, may be out of date`,
    tooltip: `${row.tooltip}\nThe base is a remote branch last fetched ${baseFetch.age}. Use "Fetch and Refresh" in the title bar.`,
    icon: 'warning',
    warning: true,
  };
}

function subjectRow(setup: ComparisonSetup, results: readonly ComparisonResult[]): HeaderRow {
  const single = setup.requests.length === 1 ? setup.requests[0] : undefined;
  const label = single !== undefined ? `Reviewing: ${single.subject.label}` : `Reviewing: ${setup.requests.length} repos (main worktrees)`;
  const worktreeSubjects = setup.requests.filter((r) => r.subject.kind === 'worktree');

  // A branch, tag or commit has no uncommitted edits: nothing to toggle.
  if (worktreeSubjects.length === 0) {
    const refKind = single?.subject.kind === 'ref' ? single.subject.refKind : 'branch';
    return {
      role: 'subject',
      label,
      description: `${refKindText(refKind)} · committed work`,
      tooltip: 'What changed: the right side of every diff, as committed.',
      icon: refKindIcon(refKind),
      warning: false,
    };
  }

  const including = worktreeSubjects.every((r) => r.subject.kind === 'worktree' && r.subject.includeUncommitted);
  if (including) {
    // How many of the listed files carry uncommitted edits (each marked ✎ in the list).
    const marked = sum(results.map((r) => uncommittedFileCount(r.files)));
    return {
      role: 'subject',
      label,
      description: `${single !== undefined ? 'worktree · ' : ''}INCLUDING uncommitted edits${marked > 0 ? ` · ✎ ${plural(marked, 'file')}` : ''}`,
      tooltip: 'What changed (the right side of every diff): files as they are on disk, i.e. commits plus staged, unstaged and (per setting) untracked edits.\n✎ marks the files with uncommitted edits; hover a file for committed, uncommitted or both.\nClick to review committed work only.',
      icon: 'edit',
      warning: false,
      command: 'gitComparePlus.toggleUncommitted',
    };
  }

  const excluded = sum(results.map((r) => r.excludedUncommitted.subject));
  return {
    role: 'subject',
    label,
    description: `${single !== undefined ? 'worktree · ' : ''}committed only${excluded > 0 ? ` · ${plural(excluded, 'uncommitted file')} NOT included` : ''}`,
    tooltip: 'What changed (the right side of every diff): only the worktree\'s last commit (HEAD); edits on disk are ignored.\nClick to include uncommitted edits.',
    icon: excluded > 0 ? 'warning' : 'git-commit',
    warning: excluded > 0,
    command: 'gitComparePlus.toggleUncommitted',
  };
}

function baseRow(setup: ComparisonSetup, results: readonly ComparisonResult[]): HeaderRow {
  const base = setup.base;
  const resolvedLabels = [...new Set(results.map((r) => r.baseLabel).filter((l): l is string => l !== undefined))];
  const common = { role: 'base' as const, icon: 'git-compare', command: 'gitComparePlus.changeBase' as const };

  switch (base.kind) {
    case 'default': {
      const label = resolvedLabels.length === 1 ? `Against: ${resolvedLabels[0]}` : "Against: each repo's default branch";
      const detail = resolvedLabels.length > 1 ? resolvedLabels.join(', ') : 'default branch';
      return {
        ...common,
        label,
        description: `${detail} · click to change`,
        tooltip: `${LEFT_SIDE} Each repo's default branch: its remote's HEAD, unless the gitComparePlus.defaultBranches setting names another.\nClick to compare against something else.`,
        warning: false,
      };
    }
    case 'ref':
      return {
        ...common,
        label: `Against: ${base.label ?? base.ref}`,
        description: `${refKindText(base.refKind)} · click to change`,
        tooltip: `${LEFT_SIDE}\nClick to compare against something else.`,
        warning: false,
      };
    case 'worktree': {
      if (base.includeUncommitted) {
        return {
          ...common,
          label: `Against: ${base.label}`,
          description: 'worktree · INCLUDING its uncommitted edits · click to change',
          tooltip: `${LEFT_SIDE} A snapshot of that worktree's files on disk, taken when the comparison ran (Refresh to retake).`,
          warning: false,
        };
      }
      const excluded = sum(results.map((r) => r.excludedUncommitted.base));
      return {
        ...common,
        label: `Against: ${base.label}`,
        description: `worktree · committed only${excluded > 0 ? ` · ${plural(excluded, 'uncommitted file')} NOT included` : ''} · click to change`,
        tooltip: `${LEFT_SIDE} That worktree's last commit (HEAD); edits on disk there are ignored.`,
        icon: excluded > 0 ? 'warning' : common.icon,
        warning: excluded > 0,
      };
    }
  }
}

function modeRow(setup: ComparisonSetup, results: readonly ComparisonResult[]): HeaderRow {
  if (baseForcesDirect(setup.base)) {
    return {
      role: 'mode',
      label: 'Showing: all differences',
      description: 'required: the base includes uncommitted edits',
      tooltip: 'Uncommitted edits have no branch point, so the two sides are compared directly.',
      icon: 'arrow-both',
      warning: false,
      command: 'gitComparePlus.toggleMode',
    };
  }
  if (setup.mode === 'merge-base') {
    return branchPointRow(results.length === 1 ? results[0] : undefined);
  }
  return {
    role: 'mode',
    label: 'Showing: all differences',
    description: 'click for changes since branch point',
    tooltip: 'Every difference between the two sides, including commits on the base the subject does not have.',
    icon: 'arrow-both',
    warning: false,
    command: 'gitComparePlus.toggleMode',
  };
}

const SINCE_BRANCH_POINT = 'Like a pull request: compared with where the branch split off, so later commits on the base are not shown.';

/**
 * "Showing: changes since branch point", naming the branch point for a one-repo comparison (see
 * module doc). `result` is undefined for several repos (each has its own branch point) or before
 * a result exists; the row then keeps the generic wording.
 */
function branchPointRow(result: ComparisonResult | undefined): HeaderRow {
  const common = { role: 'mode' as const, command: 'gitComparePlus.toggleMode' as const };
  const point = result?.branchPoint;
  const sha = result?.baseRevision?.slice(0, 7);
  if (result === undefined || point === undefined || sha === undefined) {
    return { ...common, label: 'Showing: changes since branch point', description: 'click for all differences', tooltip: SINCE_BRANCH_POINT, icon: 'git-merge', warning: false };
  }
  const against = result.baseLabel ?? 'the Against side';
  const label = `Showing: changes since branch point ${sha}`;
  if (point.isAgainstTip) {
    return {
      ...common,
      label,
      description: `the tip of ${against} · click for all differences`,
      tooltip: `${SINCE_BRANCH_POINT}\nHere the branch point is ${against} itself, so both modes show the same thing.`,
      icon: 'git-merge',
      warning: false,
    };
  }
  if (point.onDefaultBranch !== undefined) {
    // The trap: two worktrees that split off main are "compared" with a commit on main.
    return {
      ...common,
      label,
      description: `on ${point.onDefaultBranch}, not ${against}'s latest · click for all differences`,
      tooltip:
        `The left side is ${sha}, where the two histories split, and it is on ${point.onDefaultBranch}. ${against}'s own commits after that are not on the left side, ` +
        `so this shows roughly "against ${point.onDefaultBranch}", not against ${against}.\nClick for all differences to compare with ${against} itself.`,
      icon: 'warning',
      warning: true,
    };
  }
  return {
    ...common,
    label,
    description: `where it split from ${against} · click for all differences`,
    tooltip: `${SINCE_BRANCH_POINT}\nThe left side is ${sha}, where it split from ${against}.`,
    icon: 'git-merge',
    warning: false,
  };
}

// Every "Against" tooltip starts by saying which side of the diff it is.
const LEFT_SIDE = 'What it is compared with: the left side of every diff.';

/** Wording for a ref side; undefined (a typed ref, or a base saved by an older version) is "ref". */
export function refKindText(refKind: RefKind | undefined): string {
  switch (refKind) {
    case 'branch':
      return 'branch';
    case 'remote':
      return 'remote branch';
    case 'tag':
      return 'tag';
    case 'commit':
      return 'commit';
    default:
      return 'ref';
  }
}

function refKindIcon(refKind: RefKind | undefined): string {
  switch (refKind) {
    case 'tag':
      return 'tag';
    case 'commit':
      return 'git-commit';
    case 'remote':
      return 'cloud';
    default:
      return 'git-branch';
  }
}

function sum(values: readonly (number | undefined)[]): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
