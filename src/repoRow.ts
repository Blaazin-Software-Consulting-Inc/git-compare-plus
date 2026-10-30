/**
 * repoRow — wording for a repo's row in Repositories: `main · ✎ 31 uncommitted · against
 * origin/main · fetched 2 hours ago`, and the uncommitted line of its hover.
 *
 * Why the uncommitted marker is here too: the repo row stands for the folder that was cloned (its
 * main worktree), which is what people read as "my local main". Showing that worktree's
 * uncommitted work only on its row under Worktrees made it easy to miss.
 *
 * Pure; unit-tested in test/repoRow.test.ts. Used by views/repositoriesView.ts.
 */
import type { StatusCounts } from './git/parsers';
import { uncommittedText, uncommittedTooltip } from './uncommitted';

/** What the repo row shows; undefined parts are left out. */
export interface RepoRowParts {
  /** Branch checked out in the main worktree (undefined when detached or not loaded yet). */
  readonly branch?: string;
  /** The main worktree's uncommitted paths; undefined when unknown (not loaded, status failed). */
  readonly uncommitted?: StatusCounts;
  /** Label of what the compare button reviews against (`origin/main`). */
  readonly against?: string;
  /** `fetched 2 hours ago`. */
  readonly fetched?: string;
}

/** The row's description, parts joined with ` · `. */
export function repoRowDescription(parts: RepoRowParts): string {
  return [parts.branch, uncommittedText(parts.uncommitted), parts.against === undefined ? undefined : `against ${parts.against}`, parts.fetched].filter(Boolean).join(' · ');
}

/** Hover line for the main worktree's uncommitted work, or undefined when it is clean or unknown. */
export function repoRowUncommittedTooltip(uncommitted: StatusCounts | undefined): string | undefined {
  const line = uncommittedTooltip(uncommitted);
  return line === undefined ? undefined : `${line} (repo folder)`;
}
