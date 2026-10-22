/**
 * blameText — the wording of blame: the note at the end of the current line, the status bar text,
 * and the hover with its actions.
 *
 * Pure (no `vscode` import) so the wording is unit-tested; blameController.ts renders it. The hover
 * is built as Markdown text with `command:` links; author names and commit messages are escaped
 * because they are arbitrary text that could otherwise inject links or formatting.
 */
import type { BlameLine } from '../git/parsers';
import { formatAge } from '../operations';

/** Commits whose subject is longer get an ellipsis in the end-of-line note. */
const ANNOTATION_SUMMARY_CHARS = 60;

/** Commands the hover links to; each takes one `BlameTarget` argument. */
export const BLAME_COMMANDS = {
  openCommit: 'gitComparePlus.blame.openCommit',
  compareWithPrevious: 'gitComparePlus.blame.compareWithPrevious',
  compareWithWorkingTree: 'gitComparePlus.blame.compareWithWorkingTree',
} as const;

/** What a hover action acts on: one line's commit in one file of one worktree. */
export interface BlameTarget {
  /** Worktree root. */
  readonly root: string;
  /** Repo-relative path of the file today. */
  readonly path: string;
  readonly sha: string;
  /** The file's path in `sha` (differs after a rename). */
  readonly pathAtCommit: string;
  readonly previous?: { readonly sha: string; readonly path: string };
}

/** End-of-line note: `Ada Lovelace, 3 days ago · Fix login retry`, or `Uncommitted change`. */
export function blameAnnotation(line: BlameLine, nowMs: number): string {
  if (line.commit.uncommitted) {
    return 'Uncommitted change';
  }
  return `${line.commit.author}, ${formatAge(line.commit.authoredAt, nowMs)} · ${truncate(line.commit.summary, ANNOTATION_SUMMARY_CHARS)}`;
}

/** Status bar text: `Ada Lovelace, 3 days ago`, or `Uncommitted`. */
export function blameStatusText(line: BlameLine, nowMs: number): string {
  return line.commit.uncommitted ? 'Uncommitted' : `${line.commit.author}, ${formatAge(line.commit.authoredAt, nowMs)}`;
}

/**
 * Hover Markdown: author and date, the full message (or the subject until it has loaded), the
 * short SHA, and the actions. Uncommitted lines get a one-line explanation and no actions.
 * @param message - the full commit message once fetched; undefined shows the subject.
 */
export function blameHoverMarkdown(line: BlameLine, target: BlameTarget, message: string | undefined, nowMs: number): string {
  if (line.commit.uncommitted) {
    return '$(edit) **Uncommitted change**: this line differs from the last commit (it may not be saved yet).';
  }
  const { commit } = line;
  const when = new Date(commit.authoredAt).toISOString().slice(0, 16).replace('T', ' ');
  const actions = [
    `[$(git-commit) Open Commit](${commandUri(BLAME_COMMANDS.openCommit, target)} "Every file this commit changed")`,
    ...(commit.previous !== undefined
      ? [`[$(diff) Compare with Previous](${commandUri(BLAME_COMMANDS.compareWithPrevious, target)} "This file before and after the commit")`]
      : []),
    `[$(file) Compare with Working Tree](${commandUri(BLAME_COMMANDS.compareWithWorkingTree, target)} "This file at the commit and as it is now")`,
  ];
  return [
    `**${escapeMarkdown(commit.author)}**, ${formatAge(commit.authoredAt, nowMs)} (${when} UTC)`,
    '',
    // Two trailing spaces keep the message's own line breaks (Markdown joins single newlines).
    escapeMarkdown(message?.trim() || commit.summary).replace(/\n/g, '  \n'),
    '',
    `\`${commit.sha.slice(0, 7)}\` · ${actions.join(' · ')}`,
  ].join('\n');
}

/** The target for one blamed line. */
export function blameTarget(root: string, path: string, line: BlameLine): BlameTarget {
  return { root, path, sha: line.commit.sha, pathAtCommit: line.path, previous: line.commit.previous };
}

// `command:` links carry their arguments as URI-encoded JSON (an array of positional args).
function commandUri(command: string, target: BlameTarget): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([target]))}`;
}

/** Escape Markdown and HTML special characters in untrusted text (author names, messages). */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~$]/g, (ch) => `\\${ch}`);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
