/**
 * branchCandidates — ranks the branch names offered in the "compare with…" picker.
 *
 * Why: a multi-root workspace exposes hundreds of refs across repos (feature branches, tags,
 * remote mirrors). The picker should put the handful of plausible comparison bases first, and say
 * how many repos actually have each one, because comparing with a branch most repos lack skips
 * them (see `compare.ts`, outcome `ref_missing`).
 *
 * Pure module: no `vscode` import; unit-tested in test/branchCandidates.test.ts.
 */

/** Ref types from the git extension API (`RefType`). Tags are not offered as comparison bases. */
export const RefType = Object.freeze({ Head: 0, RemoteHead: 1, Tag: 2 });

/** The subset of the git extension's `Ref` this module reads. */
export interface RefInfo {
  readonly type: number;
  /** Local branches: `master`; remote branches: `origin/master`. Absent for detached refs. */
  readonly name?: string;
}

/** A branch name offered in the picker and how many repos have it. */
export interface BranchCandidate {
  readonly ref: string;
  readonly repoCount: number;
}

// Conventional integration branches, remote first: a local `master` is often stale, and the
// remote copy is what a pull request would actually be compared against.
const PREFERRED_ORDER: readonly string[] = [
  'origin/master',
  'origin/main',
  'origin/develop',
  'master',
  'main',
  'develop',
];

/**
 * Rank every branch that exists in at least one repo.
 *
 * Order: conventional integration branches (`PREFERRED_ORDER`) first, then by how many repos
 * have the branch (most first), then alphabetically for a stable list.
 *
 * @param refsPerRepo - one ref list per repository, as returned by `Repository.getRefs()`.
 * @returns unique branch names; tags and symbolic `*\/HEAD` refs are excluded.
 */
export function rankBranchCandidates(refsPerRepo: readonly (readonly RefInfo[])[]): BranchCandidate[] {
  const repoCountByRef = new Map<string, number>();
  for (const refs of refsPerRepo) {
    // A set per repo so a branch listed twice in one repo still counts that repo once.
    const namesInRepo = new Set<string>();
    for (const ref of refs) {
      if (isComparableBranch(ref)) {
        namesInRepo.add(ref.name);
      }
    }
    for (const name of namesInRepo) {
      repoCountByRef.set(name, (repoCountByRef.get(name) ?? 0) + 1);
    }
  }

  return [...repoCountByRef.entries()]
    .map(([ref, repoCount]) => ({ ref, repoCount }))
    .sort(compareCandidates);
}

function isComparableBranch(ref: RefInfo): ref is RefInfo & { name: string } {
  if (ref.name === undefined || ref.type === RefType.Tag) {
    return false;
  }
  // `origin/HEAD` is a pointer to another remote branch; offering it would duplicate that branch.
  return !ref.name.endsWith('/HEAD');
}

function compareCandidates(a: BranchCandidate, b: BranchCandidate): number {
  const rankA = preferredRank(a.ref);
  const rankB = preferredRank(b.ref);
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  if (a.repoCount !== b.repoCount) {
    return b.repoCount - a.repoCount;
  }
  return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
}

function preferredRank(ref: string): number {
  const index = PREFERRED_ORDER.indexOf(ref);
  return index === -1 ? PREFERRED_ORDER.length : index;
}
