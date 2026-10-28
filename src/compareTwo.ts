/**
 * compareTwo — "Compare These Two" on two selected worktrees or branches in Repositories: the
 * direct way to compare two worktrees, with no doubt about either side.
 *
 * The user picks the direction ("Review A against B" or "Review B against A"); both choices say
 * which side is which in the diff. The comparison shows all differences (direct mode): two
 * worktrees or branches compared since their branch point would show "against main", the trap
 * againstMode.ts describes. Each side keeps what its row stands for: a worktree is its files on
 * disk or its last commit, per the `includeUncommitted` setting, on both sides alike.
 *
 * Also "Use as Against" (`useAsAgainst`): a right-clicked row becomes the Against side of the
 * comparison already in Changes, the other way to compare two rows without changing a default.
 *
 * Pure; unit-tested in test/compareTwo.test.ts. extension.ts shows the choices as a quick pick.
 */
import type { BaseSpec, CompareMode, RepoInfo, Subject } from './comparison';
import { subjectAsBase } from './swapSides';
import type { ComparisonSetup } from './views/changesHeader';

/** One selected row, as the side it would be when reviewed. */
export interface PairSide {
  readonly repo: RepoInfo;
  readonly subject: Subject;
}

/** One direction to compare in. */
export interface CompareTwoChoice {
  readonly label: string;
  readonly detail: string;
  readonly setup: ComparisonSetup;
}

/**
 * The two directions for a pair of selected rows, `first` reviewed against `second` first.
 * @returns the choices, or why the two cannot be compared (shown to the user as is).
 */
export function compareTwoChoices(first: PairSide, second: PairSide): { readonly choices: readonly CompareTwoChoice[] } | { readonly reason: string } {
  if (first.repo.commonDir !== second.repo.commonDir) {
    return { reason: `${first.subject.label} and ${second.subject.label} are in different repositories (${first.repo.name}, ${second.repo.name}), which share no history to compare.` };
  }
  if (sameSide(first.subject, second.subject)) {
    return { reason: `Both rows are ${first.subject.label}: pick two different worktrees or branches.` };
  }
  return { choices: [choice(first, second), choice(second, first)] };
}

function choice(reviewing: PairSide, against: PairSide): CompareTwoChoice {
  return {
    label: `Review ${reviewing.subject.label} against ${against.subject.label}`,
    detail: `${sideText(reviewing.subject)} on the right of every diff; ${sideText(against.subject)} on the left. All differences between them.`,
    setup: { requests: [{ repo: reviewing.repo, subject: reviewing.subject }], base: subjectAsBase(against.subject), mode: 'direct' },
  };
}

// `feature-x (files on disk)`, `feature-x (last commit)` or `origin/main`.
function sideText(subject: Subject): string {
  if (subject.kind === 'ref') {
    return subject.label;
  }
  return `${subject.label} (${subject.includeUncommitted ? 'files on disk' : 'last commit'})`;
}

function sameSide(a: Subject, b: Subject): boolean {
  return a.kind === 'worktree' ? b.kind === 'worktree' && a.root === b.root : b.kind === 'ref' && a.ref === b.ref;
}

/**
 * "Use as Against": the comparison on display with `row` as its Against side, for that comparison
 * only. Requests from other repos are dropped (the Against belongs to `row`'s repo).
 * @param shown - the comparison Changes is showing.
 * @param modeFor - the mode to start in against `base` (againstMode.ts).
 * @returns the new setup, or why it cannot be built (shown to the user as is).
 */
export function useAsAgainst(
  shown: ComparisonSetup,
  row: PairSide,
  modeFor: (repo: RepoInfo, base: BaseSpec) => CompareMode,
): { readonly setup: ComparisonSetup } | { readonly reason: string } {
  const requests = shown.requests.filter((r) => r.repo.commonDir === row.repo.commonDir);
  if (requests.length === 0) {
    const reviewing = [...new Set(shown.requests.map((r) => r.repo.name))].join(', ');
    return { reason: `Changes is reviewing ${reviewing}, not ${row.repo.name}. Click a worktree or branch of ${row.repo.name} first, then right-click another → Use as Against.` };
  }
  if (requests.some((r) => sameSide(r.subject, row.subject))) {
    return { reason: `${row.subject.label} is what Changes is reviewing. Right-click a different worktree or branch → Use as Against.` };
  }
  const base = subjectAsBase(row.subject);
  return { setup: { requests, base, mode: modeFor(row.repo, base) } };
}
