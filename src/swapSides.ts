/**
 * swapSides — "Swap Sides" in the Changes view: what was being reviewed becomes the base, and the
 * base becomes what is reviewed (e.g. "what does main have that my branch lacks").
 *
 * Each side keeps exactly what it showed: a worktree INCLUDING uncommitted edits becomes a base
 * that includes them (a snapshot, which forces "all differences"); committed-only stays committed
 * only. The default branch is swapped as the branch it resolved to (`origin/master`), since the
 * subject side needs a concrete ref.
 *
 * Only for one-repo comparisons: "each repo's default branch" vs several worktrees has no single
 * side to swap into.
 *
 * Pure; unit-tested in test/swapSides.test.ts.
 */
import type { BaseSpec, ComparisonResult, Subject } from './comparison';
import type { ComparisonSetup } from './views/changesHeader';

/** The swapped setup, or why it cannot be swapped (shown to the user as is). */
export type SwapOutcome = { readonly setup: ComparisonSetup } | { readonly reason: string };

/** Swap subject and base of the comparison on display. */
export function swapSides(setup: ComparisonSetup, results: readonly ComparisonResult[]): SwapOutcome {
  const only = setup.requests.length === 1 ? setup.requests[0] : undefined;
  if (only === undefined) {
    return { reason: 'Swap Sides works when one repository is compared. Compare a single worktree or branch first.' };
  }
  const subject = baseAsSubject(setup.base, results[0]?.baseLabel);
  if (subject === undefined) {
    return { reason: "The default branch of this repository wasn't found, so there is nothing to swap in." };
  }
  return { setup: { ...setup, requests: [{ repo: only.repo, subject }], base: subjectAsBase(only.subject) } };
}

function baseAsSubject(base: BaseSpec, resolvedLabel: string | undefined): Subject | undefined {
  switch (base.kind) {
    case 'default':
      // The default branch is usually a remote one (`origin/main`), occasionally local (`main`).
      return resolvedLabel === undefined ? undefined : { kind: 'ref', ref: resolvedLabel, label: resolvedLabel, refKind: resolvedLabel.includes('/') ? 'remote' : 'branch' };
    case 'ref':
      return { kind: 'ref', ref: base.ref, label: base.label ?? base.ref, refKind: base.refKind };
    case 'worktree':
      return { kind: 'worktree', root: base.root, label: base.label, includeUncommitted: base.includeUncommitted };
  }
}

/** The Against side that shows exactly what `subject` shows (uncommitted edits included or not). */
export function subjectAsBase(subject: Subject): BaseSpec {
  return subject.kind === 'worktree'
    ? { kind: 'worktree', root: subject.root, label: subject.label, includeUncommitted: subject.includeUncommitted }
    : { kind: 'ref', ref: subject.ref, refKind: subject.refKind, label: subject.label };
}
