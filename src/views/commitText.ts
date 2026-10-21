/**
 * commitText — wording of the Commits section in the Changes view.
 *
 * Pure (no `vscode` import) so it is unit-tested directly; changesView.ts renders it.
 */
import type { CommitList } from '../comparison';
import type { CommitEntry } from '../git/parsers';
import { formatAge } from '../operations';

/** Characters of a SHA shown on a row; enough to be unique in practically any repo. */
const SHORT_SHA_LENGTH = 7;

/** Group row count: `12`, or `200+` when the list was cut off. */
export function commitCountText(commits: CommitList): string {
  return `${commits.entries.length}${commits.truncated ? '+' : ''}`;
}

/** Commit row description: `abc1234 · Ada · 3 days ago` (merges say so). */
export function commitDescription(commit: CommitEntry, nowMs: number): string {
  return [
    commit.sha.slice(0, SHORT_SHA_LENGTH),
    ...(commit.parents.length > 1 ? ['merge'] : []),
    commit.author,
    formatAge(commit.authoredAt, nowMs),
  ].join(' · ');
}

/** Commit row hover: full SHA, author and date, subject, and what clicking does. */
export function commitTooltip(commit: CommitEntry): string {
  const what =
    commit.parents.length === 0
      ? 'First commit of the history: there is no earlier version to compare with.'
      : commit.parents.length > 1
        ? 'Merge commit: click to open what it brought in, compared with its first parent.'
        : 'Click to open the files this commit changed.';
  return `${commit.subject}\n${commit.sha}\n${commit.author}, ${new Date(commit.authoredAt).toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n${what}`;
}

/** Diff title for one commit: `abc1234 Fix the thing`. */
export function commitTitle(commit: CommitEntry): string {
  return `${commit.sha.slice(0, SHORT_SHA_LENGTH)} ${commit.subject}`;
}
