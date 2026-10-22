/**
 * commitSearch — the kinds of commit search and the `git log` arguments for each.
 *
 * Kinds, each a plain question:
 *   message   commits whose message contains the text (case-insensitive)
 *   author    commits whose author name or email contains the text (case-insensitive)
 *   file      commits that changed a file whose path contains the text (case-insensitive)
 *   code      commits that added or removed the text in some file (`git log -S`, "pickaxe")
 *   id        one commit by full or short ID (or any ref, e.g. a tag)
 *
 * Every search looks at all branches and tags (`--all`), newest first, at most SEARCH_LIMIT.
 *
 * Pure; unit-tested in test/commitSearch.test.ts.
 */

/** Commits listed per search; the view says when there are more. */
export const SEARCH_LIMIT = 200;

/** What to search for. */
export type SearchKind = 'message' | 'author' | 'file' | 'code' | 'id';

/** One search: the kind and the text typed. */
export interface CommitQuery {
  readonly kind: SearchKind;
  readonly text: string;
}

/** The choices of "Search commits by…", in order, with the input box prompt for each. */
export const SEARCH_KINDS: readonly { readonly kind: SearchKind; readonly label: string; readonly detail: string; readonly prompt: string }[] = [
  { kind: 'message', label: '$(comment) Message', detail: 'Commits whose message contains the text', prompt: 'Text in the commit message (not case-sensitive)' },
  { kind: 'author', label: '$(person) Author', detail: 'Commits by an author whose name or email contains the text', prompt: 'Author name or email (not case-sensitive)' },
  { kind: 'file', label: '$(file) File', detail: 'Commits that changed a file whose path contains the text', prompt: 'Part of a file path, e.g. login or src/auth/' },
  { kind: 'code', label: '$(code) Changed text', detail: 'Commits that added or removed the text in some file', prompt: 'Exact text added or removed, e.g. a function name' },
  { kind: 'id', label: '$(git-commit) Commit ID', detail: 'One commit by its ID (full or short), or a tag', prompt: 'Commit ID, e.g. abcdef0' },
];

/**
 * `git log` arguments (after `log` and the format options) for a search; undefined for `id`,
 * which is looked up directly instead.
 */
export function searchArgs(query: CommitQuery): string[] | undefined {
  const text = query.text.trim();
  switch (query.kind) {
    case 'message':
      return ['--all', '-i', '--fixed-strings', `--grep=${text}`];
    case 'author':
      return ['--all', '-i', '--fixed-strings', `--author=${text}`];
    case 'code':
      return ['--all', `-S${text}`];
    case 'file':
      // Pathspec magic: case-insensitive; in git's default (non-glob) matching `*` also matches
      // `/`, so `*text*` finds the text anywhere in the path, folders included.
      return ['--all', '--', `:(icase)*${escapeGlob(text)}*`];
    case 'id':
      return undefined;
  }
}

/** View description for a search: `message contains "login" · 12 commits` (`200+`). */
export function searchDescription(query: CommitQuery, count: number, truncated: boolean): string {
  const what = {
    message: `message contains "${query.text}"`,
    author: `author contains "${query.text}"`,
    file: `changed a file matching "${query.text}"`,
    code: `added or removed "${query.text}"`,
    id: `commit ${query.text}`,
  }[query.kind];
  return `${what} · ${count}${truncated ? '+' : ''} commit${count === 1 && !truncated ? '' : 's'}`;
}

// Glob characters typed by the user are matched literally.
function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, (ch) => `\\${ch}`);
}
