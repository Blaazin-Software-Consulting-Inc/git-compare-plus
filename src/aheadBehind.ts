/**
 * aheadBehind — how many commits each worktree and branch is ahead of / behind the repo's
 * comparison base, shown as `↑3 ↓12` on its row in Repositories.
 *
 * Why: before this, the only way to learn whether a branch had anything in it, or had fallen far
 * behind main, was to run a comparison. The counts answer that at a glance, against the same base
 * the compare button uses (the default branch unless "Set as Comparison Base" chose another).
 *
 * Definitions (base B, item X): ahead = commits in X not in B (`B..X`); behind = commits in B
 * not in X (`X..B`). A worktree base counts against that worktree's HEAD commit: ahead/behind is
 * about commits, so uncommitted edits never take part.
 *
 * Cost: one `git for-each-ref --format=%(ahead-behind:<base>)` for every branch at once (git 2.41+,
 * a single history walk). On older git (Apple's bundled git has lagged behind) it falls back to one
 * `rev-list --count` per LOCAL branch and detached worktree, run a few at a time; remote branches
 * then get no counts, since there can be hundreds of them.
 *
 * Cosmetic: any failure leaves the counts out (WARN) instead of failing the repo's row.
 *
 * Pure apart from the injected port; unit-tested in test/aheadBehind.test.ts.
 */
import type { BaseSpec } from './comparison';
import type { RefEntry, WorktreeEntry } from './git/parsers';
import type { Logger } from './logger';

/** Commit counts relative to the base. */
export interface AheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

/** Counts for one repo, keyed so both branch rows and worktree rows can look themselves up. */
export interface AheadBehindCounts {
  /** What the counts are relative to, for tooltips (`origin/master`, a worktree's branch). */
  readonly baseLabel: string;
  /** Short ref name (`feature/x`, `origin/feature/x`) → counts. */
  readonly byRef: ReadonlyMap<string, AheadBehind>;
  /** Commit SHA → counts, for detached worktrees (no branch to look up). */
  readonly byCommit: ReadonlyMap<string, AheadBehind>;
}

/** Git access needed. Implemented by GitCli. */
export interface AheadBehindPort {
  resolveCommit(cwd: string, revision: string): Promise<string | undefined>;
  /** Every local and remote branch against `baseSha`; `undefined` when this git cannot (< 2.41). */
  aheadBehindAllRefs(cwd: string, baseSha: string): Promise<Map<string, AheadBehind> | undefined>;
  /** One revision against `baseSha`. */
  aheadBehind(cwd: string, baseSha: string, revision: string): Promise<AheadBehind>;
}

// Per-ref fallback calls in flight at once: each is a history walk, and a repo can have dozens of
// local branches; a few at a time keeps a large repo from saturating the machine.
const FALLBACK_CONCURRENCY = 4;

/**
 * The commit-ish to count against for a repo's comparison base, with its label.
 * @param base - the base set for the repo; undefined = default branch.
 * @param defaultBranch - resolved default branch, if any.
 * @param worktrees - the repo's worktrees, to find a worktree base's HEAD.
 * @returns undefined when the base cannot be resolved (no default branch, worktree gone).
 */
export function aheadBehindBase(
  base: BaseSpec | undefined,
  defaultBranch: string | undefined,
  worktrees: readonly WorktreeEntry[],
): { readonly label: string; readonly commitish: string } | undefined {
  if (base === undefined || base.kind === 'default') {
    return defaultBranch === undefined ? undefined : { label: defaultBranch, commitish: defaultBranch };
  }
  if (base.kind === 'ref') {
    return { label: base.ref, commitish: base.ref };
  }
  const head = worktrees.find((w) => w.path === base.root)?.head;
  return head === undefined ? undefined : { label: base.label, commitish: head };
}

/**
 * Load the counts for one repo.
 * @param cwd - the repo's main worktree.
 * @returns undefined when the base is unresolvable or git failed (logged); never throws.
 */
export async function loadAheadBehind(
  git: AheadBehindPort,
  cwd: string,
  base: { readonly label: string; readonly commitish: string },
  refs: readonly RefEntry[],
  worktrees: readonly WorktreeEntry[],
  logger: Logger,
): Promise<AheadBehindCounts | undefined> {
  try {
    // Resolve once: the format atom and rev-list then get a SHA, never a user-typed ref string.
    const baseSha = await git.resolveCommit(cwd, base.commitish);
    if (baseSha === undefined) {
      logger.debug('ahead/behind skipped: base does not resolve', { function: 'loadAheadBehind', cwd, base });
      return undefined;
    }
    const all = await git.aheadBehindAllRefs(cwd, baseSha);
    const byRef = all ?? (await countEach(git, cwd, baseSha, refs.filter((r) => r.kind === 'local').map((r) => r.name)));
    if (all === undefined) {
      logger.debug('ahead/behind counted per branch (git < 2.41); remote branches skipped', { function: 'loadAheadBehind', cwd, localCount: byRef.size });
    }
    // Detached worktrees have no ref entry; count their HEAD commit directly.
    const detachedHeads = worktrees.flatMap((w) => (w.branch === undefined && w.head !== undefined && !w.bare && !w.prunable ? [w.head] : []));
    const byCommit = await countEach(git, cwd, baseSha, detachedHeads);
    return { baseLabel: base.label, byRef, byCommit };
  } catch (error) {
    logger.warn('ahead/behind counts unavailable; rows shown without them', {
      function: 'loadAheadBehind',
      cwd,
      base,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function countEach(git: AheadBehindPort, cwd: string, baseSha: string, revisions: readonly string[]): Promise<Map<string, AheadBehind>> {
  const counts = new Map<string, AheadBehind>();
  for (let start = 0; start < revisions.length; start += FALLBACK_CONCURRENCY) {
    const batch = revisions.slice(start, start + FALLBACK_CONCURRENCY);
    const results = await Promise.all(batch.map((revision) => git.aheadBehind(cwd, baseSha, revision)));
    batch.forEach((revision, i) => {
      const result = results[i];
      if (result !== undefined) {
        counts.set(revision, result);
      }
    });
  }
  return counts;
}

/** Counts for a worktree row: by its branch, or by its HEAD commit when detached. */
export function worktreeAheadBehind(counts: AheadBehindCounts | undefined, worktree: WorktreeEntry): AheadBehind | undefined {
  if (counts === undefined) {
    return undefined;
  }
  return worktree.branch !== undefined ? counts.byRef.get(worktree.branch) : worktree.head !== undefined ? counts.byCommit.get(worktree.head) : undefined;
}

/**
 * Row text: `↑3 ↓12`, `↑3`, `↓12`, or `''` when even with the base or unknown. Zero sides are left
 * out so the many branches level with the base don't each carry "↑0 ↓0".
 */
export function aheadBehindText(counts: AheadBehind | undefined): string {
  if (counts === undefined) {
    return '';
  }
  return [counts.ahead > 0 ? `↑${counts.ahead}` : '', counts.behind > 0 ? `↓${counts.behind}` : ''].filter((part) => part.length > 0).join(' ');
}

/** Tooltip line, e.g. `3 commits ahead of origin/master, 12 behind`, or undefined when unknown. */
export function aheadBehindTooltip(counts: AheadBehind | undefined, baseLabel: string): string | undefined {
  if (counts === undefined) {
    return undefined;
  }
  if (counts.ahead === 0 && counts.behind === 0) {
    return `Even with ${baseLabel}`;
  }
  return `${counts.ahead} commit${counts.ahead === 1 ? '' : 's'} ahead of ${baseLabel}, ${counts.behind} behind`;
}
