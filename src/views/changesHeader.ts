/**
 * changesHeader — the three clickable rows at the top of the Changes view that say exactly what
 * is being compared, and let the user change it:
 *
 *   Comparing: feature-x     worktree · including uncommitted edits          (click: toggle)
 *   With: origin/master      default branch · click to change               (click: pick base)
 *   Showing: changes since branch point · click for all differences         (click: toggle mode)
 *
 * Uncommitted edits must never be silently missing, so when a side is "committed only" and the
 * worktree HAS uncommitted files, the row says how many are NOT included and is flagged as a warning.
 *
 * Pure (no `vscode` import) so the wording is unit-tested; changesView.ts renders the rows.
 */
import { baseForcesDirect, type BaseSpec, type CompareMode, type ComparisonRequest, type ComparisonResult } from '../comparison';

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
  readonly command?: 'branchCompare.toggleUncommitted' | 'branchCompare.changeBase' | 'branchCompare.toggleMode';
}

/**
 * Freshness of a remote-tracking base (e.g. `origin/master`): `age` is display text ("3 days ago",
 * "never"), `stale` when older than the `staleFetchHours` setting. Undefined for local bases.
 */
export interface BaseFetchInfo {
  readonly age: string;
  readonly stale: boolean;
}

/** Build the header rows for a comparison and its results. */
export function describeHeader(setup: ComparisonSetup, results: readonly ComparisonResult[], baseFetch?: BaseFetchInfo): HeaderRow[] {
  return [subjectRow(setup, results), withFetchWarning(baseRow(setup, results), baseFetch), modeRow(setup)];
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
  const label = single !== undefined ? `Comparing: ${single.subject.label}` : `Comparing: ${setup.requests.length} repos (main worktrees)`;
  const worktreeSubjects = setup.requests.filter((r) => r.subject.kind === 'worktree');

  // A branch has no uncommitted edits: nothing to toggle.
  if (worktreeSubjects.length === 0) {
    return { role: 'subject', label, description: 'branch · committed work', tooltip: 'The branch tip, as committed.', icon: 'git-branch', warning: false };
  }

  const including = worktreeSubjects.every((r) => r.subject.kind === 'worktree' && r.subject.includeUncommitted);
  if (including) {
    return {
      role: 'subject',
      label,
      description: `${single !== undefined ? 'worktree · ' : ''}INCLUDING uncommitted edits`,
      tooltip: 'Files as they are on disk: commits plus staged, unstaged and (per setting) untracked edits.\nClick to compare committed work only.',
      icon: 'edit',
      warning: false,
      command: 'branchCompare.toggleUncommitted',
    };
  }

  const excluded = sum(results.map((r) => r.excludedUncommitted.subject));
  return {
    role: 'subject',
    label,
    description: `${single !== undefined ? 'worktree · ' : ''}committed only${excluded > 0 ? ` · ${plural(excluded, 'uncommitted file')} NOT included` : ''}`,
    tooltip: 'Only the worktree\'s last commit (HEAD) is compared; edits on disk are ignored.\nClick to include uncommitted edits.',
    icon: excluded > 0 ? 'warning' : 'git-commit',
    warning: excluded > 0,
    command: 'branchCompare.toggleUncommitted',
  };
}

function baseRow(setup: ComparisonSetup, results: readonly ComparisonResult[]): HeaderRow {
  const base = setup.base;
  const resolvedLabels = [...new Set(results.map((r) => r.baseLabel).filter((l): l is string => l !== undefined))];
  const common = { role: 'base' as const, icon: 'git-compare', command: 'branchCompare.changeBase' as const };

  switch (base.kind) {
    case 'default': {
      const label = resolvedLabels.length === 1 ? `With: ${resolvedLabels[0]}` : "With: each repo's default branch";
      const detail = resolvedLabels.length > 1 ? resolvedLabels.join(', ') : 'default branch';
      return { ...common, label, description: `${detail} · click to change`, tooltip: "Each repo's default branch: its remote's HEAD, unless the branchCompare.defaultBranches setting names another.\nClick to compare with another branch or worktree.", warning: false };
    }
    case 'ref':
      return { ...common, label: `With: ${base.ref}`, description: 'click to change', tooltip: 'Click to compare with another branch or worktree.', warning: false };
    case 'worktree': {
      if (base.includeUncommitted) {
        return {
          ...common,
          label: `With: ${base.label}`,
          description: 'worktree · INCLUDING its uncommitted edits · click to change',
          tooltip: 'A snapshot of that worktree\'s files on disk, taken when the comparison ran (Refresh to retake).',
          warning: false,
        };
      }
      const excluded = sum(results.map((r) => r.excludedUncommitted.base));
      return {
        ...common,
        label: `With: ${base.label}`,
        description: `worktree · committed only${excluded > 0 ? ` · ${plural(excluded, 'uncommitted file')} NOT included` : ''} · click to change`,
        tooltip: 'That worktree\'s last commit (HEAD); edits on disk there are ignored.',
        icon: excluded > 0 ? 'warning' : common.icon,
        warning: excluded > 0,
      };
    }
  }
}

function modeRow(setup: ComparisonSetup): HeaderRow {
  if (baseForcesDirect(setup.base)) {
    return {
      role: 'mode',
      label: 'Showing: all differences',
      description: 'required: the base includes uncommitted edits',
      tooltip: 'Uncommitted edits have no branch point, so the two sides are compared directly.',
      icon: 'arrow-both',
      warning: false,
      command: 'branchCompare.toggleMode',
    };
  }
  return setup.mode === 'merge-base'
    ? {
        role: 'mode',
        label: 'Showing: changes since branch point',
        description: 'click for all differences',
        tooltip: 'Like a pull request: compared with where the branch split off, so later commits on the base are not shown.',
        icon: 'git-merge',
        warning: false,
        command: 'branchCompare.toggleMode',
      }
    : {
        role: 'mode',
        label: 'Showing: all differences',
        description: 'click for changes since branch point',
        tooltip: 'Every difference between the two sides, including commits on the base the subject does not have.',
        icon: 'arrow-both',
        warning: false,
        command: 'branchCompare.toggleMode',
      };
}

function sum(values: readonly (number | undefined)[]): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
