/**
 * branchCommits — which commits the Commits view lists when a worktree or branch is selected in
 * Repositories.
 *
 *   auto     the commits it has that its repo's default Against does not ("3 commits on feature-x
 *            not on origin/main"): what you would review, and what the row's ↑3 counts. When there
 *            are none (e.g. selecting main itself), its recent history instead.
 *   history  always its recent history, newest first.
 *
 * Both stop at BRANCH_COMMITS_LIMIT and say when there are more. Pure apart from the injected
 * port; unit-tested in test/branchCommits.test.ts.
 */
import type { CommitEntry } from '../git/parsers';

/** Commits listed for a selected branch or worktree. */
export const BRANCH_COMMITS_LIMIT = 200;

/** `auto` = ahead of the default Against when there is anything, else history; `history` = always history. */
export type BranchCommitsMode = 'auto' | 'history';

/** Git access needed. Implemented by GitCli. */
export interface BranchCommitsPort {
  resolveCommit(cwd: string, revision: string): Promise<string | undefined>;
  commitsBetween(cwd: string, from: string, to: string, limit: number): Promise<CommitEntry[]>;
  log(cwd: string, revision: string, limit: number): Promise<CommitEntry[]>;
}

/** What was selected. */
export interface BranchCommitsRequest {
  /** Where git runs: the worktree, or the repo's main worktree for a branch. */
  readonly cwd: string;
  /** What to list: a branch name, or a worktree's HEAD commit. */
  readonly revision: string;
  /** Row name for the view title (`feature-x`). */
  readonly label: string;
  /** The repo's default Against, resolved to a commit-ish; undefined when it has none. */
  readonly against?: { readonly label: string; readonly commitish: string };
  /** Set for a worktree (or repo) row: its uncommitted changes are listed above the commits. */
  readonly worktree?: { readonly root: string; readonly label: string };
}

/** The commits to show and how to describe them. */
export interface BranchCommits {
  readonly commits: readonly CommitEntry[];
  readonly truncated: boolean;
  /** Which list this is (auto may fall back to history). */
  readonly shown: 'ahead' | 'history';
  /** View description, e.g. `3 commits not on origin/main` or `history · 200+ commits`. */
  readonly description: string;
}

/** Load the list for a selection (see module doc). */
export async function loadBranchCommits(git: BranchCommitsPort, request: BranchCommitsRequest, mode: BranchCommitsMode): Promise<BranchCommits> {
  const { against } = request;
  if (mode === 'auto' && against !== undefined) {
    const [againstSha, revisionSha] = await Promise.all([git.resolveCommit(request.cwd, against.commitish), git.resolveCommit(request.cwd, request.revision)]);
    if (againstSha !== undefined && revisionSha !== undefined && againstSha !== revisionSha) {
      const ahead = await git.commitsBetween(request.cwd, againstSha, revisionSha, BRANCH_COMMITS_LIMIT + 1);
      if (ahead.length > 0) {
        const shown = ahead.slice(0, BRANCH_COMMITS_LIMIT);
        const truncated = ahead.length > BRANCH_COMMITS_LIMIT;
        return { commits: shown, truncated, shown: 'ahead', description: `${count(shown.length, truncated)} not on ${against.label}` };
      }
    }
  }
  const history = await git.log(request.cwd, request.revision, BRANCH_COMMITS_LIMIT + 1);
  const shown = history.slice(0, BRANCH_COMMITS_LIMIT);
  const truncated = history.length > BRANCH_COMMITS_LIMIT;
  // In auto mode, say why this is the full history rather than "what it adds".
  const why = mode === 'auto' && against !== undefined ? ` · nothing that ${against.label} doesn't have` : '';
  return { commits: shown, truncated, shown: 'history', description: `history · ${count(shown.length, truncated)}${why}` };
}

function count(n: number, truncated: boolean): string {
  return `${n}${truncated ? '+' : ''} commit${n === 1 && !truncated ? '' : 's'}`;
}
