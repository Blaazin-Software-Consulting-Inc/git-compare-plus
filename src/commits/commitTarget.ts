/**
 * commitTarget — "a commit in a repo", the one shape every commit list hands to the shared commit
 * actions (commitActions.ts): the Commits group in Changes, the History view, and the Commits view.
 */
import type { RepoInfo } from '../comparison';
import type { CommitEntry } from '../git/parsers';

/** A commit, the repo it belongs to, and the worktree to run git in. */
export interface CommitTarget {
  readonly repo: RepoInfo;
  /** A worktree of `repo` (the commit is readable from any of them). */
  readonly root: string;
  readonly commit: CommitEntry;
}

/**
 * Order two commits of one repo for a comparison: the older one is the Against side (left), the
 * newer one is Reviewing (right). By author date, then by ID so the order is stable.
 */
export function olderFirst(a: CommitTarget, b: CommitTarget): [CommitTarget, CommitTarget] {
  if (a.commit.authoredAt !== b.commit.authoredAt) {
    return a.commit.authoredAt < b.commit.authoredAt ? [a, b] : [b, a];
  }
  return a.commit.sha < b.commit.sha ? [a, b] : [b, a];
}
