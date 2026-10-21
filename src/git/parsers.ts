/**
 * parsers — pure parsers for the git plumbing output this extension consumes.
 *
 * Why separate: every git interaction goes through `GitCli` (gitCli.ts), which shells out. Keeping
 * the text → data step pure lets the tricky formats (NUL-separated name-status with rename pairs,
 * porcelain worktree blocks) be unit-tested against captured output without a repository.
 *
 * Formats verified against git 2.53.
 */

/** How a file differs between the base and the subject of a comparison. */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

/** One changed file. Paths are repo-relative, POSIX-separated, exactly as git prints them. */
export interface ChangedFile {
  readonly status: FileStatus;
  /** Path on the subject side (the new path for renames). */
  readonly path: string;
  /** Path on the base side (the old path for renames; equals `path` otherwise). */
  readonly oldPath: string;
  /**
   * Lines added/removed, attached by the comparison (comparison.ts). Absent when unknown: stats
   * are best-effort, so a failed `--numstat` or an unreadable untracked file leaves them out.
   */
  readonly lines?: LineStats;
  /**
   * Identity of this exact diff: `<left object>><right object>` (`-` for an empty side), attached
   * by the comparison (src/review/fingerprints.ts). "Reviewed" marks are stored against it, so a
   * mark lapses as soon as either side changes. Absent when it could not be determined.
   */
  readonly fingerprint?: string;
}

/**
 * Line counts for one file, as `git diff --numstat` reports them. `binary` files have no line
 * counts (git prints `-\t-`); `added`/`deleted` are then 0 and must not be shown as numbers.
 */
export interface LineStats {
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
}

/** One commit of a comparison's history (`git log`, format `COMMIT_LOG_FORMAT`). */
export interface CommitEntry {
  /** Full SHA. */
  readonly sha: string;
  /** Full parent SHAs; empty for a root commit, two or more for a merge. */
  readonly parents: readonly string[];
  readonly author: string;
  /** Author date, ms since epoch (when the change was written, not when it was rebased). */
  readonly authoredAt: number;
  /** First line of the message. */
  readonly subject: string;
}

/**
 * `--format` for `git log -z` matching `parseCommitLog`. Fields are split by U+001F (unit
 * separator), which git log output cannot otherwise contain in these fields; `-z` ends each record
 * with NUL so a subject can never be mistaken for the next record.
 */
export const COMMIT_LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%at%x1f%s';

/** One entry of `git worktree list --porcelain`. The first entry is always the main worktree. */
export interface WorktreeEntry {
  /** Absolute path of the worktree's root directory. */
  readonly path: string;
  /** Commit checked out (full SHA); absent for a bare repository entry. */
  readonly head?: string;
  /** Short branch name (`refs/heads/` stripped); absent when detached or bare. */
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  /** Git reports the directory as missing; the entry is stale until `git worktree prune`. */
  readonly prunable: boolean;
}

/** A local or remote-tracking branch from `git for-each-ref` (format in `REF_LIST_FORMAT`). */
export interface RefEntry {
  /** Short name: `feature/x` for local, `origin/feature/x` for remote. */
  readonly name: string;
  readonly kind: 'local' | 'remote';
  /** Abbreviated commit SHA the branch points at. */
  readonly sha: string;
  /** Configured upstream (`origin/feature/x`), local branches only. */
  readonly upstream?: string;
  /** True for the branch checked out in the worktree that ran the command. */
  readonly isHead: boolean;
  /** Committer date of the branch tip, ms since epoch; used to order branches newest first. */
  readonly committedAt?: number;
}

/** `--format` for `git for-each-ref` matching `parseRefList`. `%00` makes git emit NUL separators. */
export const REF_LIST_FORMAT = '%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)%00%(committerdate:unix)';

/**
 * Parse `git diff --name-status -z [-M]`.
 *
 * Token stream: `<code>\0<path>\0` for most changes, `R<score>\0<old>\0<new>\0` for renames and
 * `C<score>\0<src>\0<dst>\0` for copies. Copies are reported as additions of the destination
 * (the source is unchanged). Type changes (`T`) and unmerged paths (`U`) are shown as
 * modifications; `X`/`B` (git-internal error codes) are dropped.
 */
export function parseNameStatusZ(stdout: string): ChangedFile[] {
  const tokens = stdout.split('\0');
  const files: ChangedFile[] = [];
  let i = 0;
  // Each iteration consumes one record (2 or 3 tokens); a truncated trailing record ends the loop.
  while (i < tokens.length) {
    const code = tokens[i++];
    // The output ends with a NUL, so the final token is empty.
    if (!code) {
      continue;
    }
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const source = tokens[i++];
      const destination = tokens[i++];
      if (!source || !destination) {
        break;
      }
      files.push(
        letter === 'R'
          ? { status: 'renamed', path: destination, oldPath: source }
          : { status: 'added', path: destination, oldPath: destination },
      );
      continue;
    }
    const filePath = tokens[i++];
    if (!filePath) {
      break;
    }
    const status = statusForLetter(letter);
    if (status !== undefined) {
      files.push({ status, path: filePath, oldPath: filePath });
    }
  }
  return files;
}

/**
 * Parse `git diff --numstat -z [-M]` into subject-side path → line counts.
 *
 * Token stream: `<added>\t<deleted>\t<path>\0` for most changes. For renames and copies the path
 * field is empty and two more tokens follow: `<added>\t<deleted>\t\0<old>\0<new>\0`. Keyed by the
 * NEW path so it lines up with `ChangedFile.path` from `parseNameStatusZ` (same `-M` setting).
 * Binary files print `-` for both counts.
 */
export function parseNumstatZ(stdout: string): Map<string, LineStats> {
  const tokens = stdout.split('\0');
  const stats = new Map<string, LineStats>();
  let i = 0;
  // Each iteration consumes one record (1 or 3 tokens); a truncated trailing record ends the loop.
  while (i < tokens.length) {
    const record = tokens[i++];
    if (!record) {
      continue;
    }
    const [addedText, deletedText, inlinePath] = splitNumstatRecord(record);
    let filePath = inlinePath;
    if (filePath === '') {
      // Rename/copy: skip the old path, the new one is the key.
      i++;
      filePath = tokens[i++] ?? '';
      if (filePath === '') {
        break;
      }
    }
    const binary = addedText === '-' && deletedText === '-';
    stats.set(filePath, {
      added: binary ? 0 : Number.parseInt(addedText, 10) || 0,
      deleted: binary ? 0 : Number.parseInt(deletedText, 10) || 0,
      binary,
    });
  }
  return stats;
}

// Split on the first two tabs only: a path may itself contain tabs.
function splitNumstatRecord(record: string): [string, string, string] {
  const first = record.indexOf('\t');
  const second = first < 0 ? -1 : record.indexOf('\t', first + 1);
  if (second < 0) {
    return ['-', '-', ''];
  }
  return [record.slice(0, first), record.slice(first + 1, second), record.slice(second + 1)];
}

/**
 * Parse `git for-each-ref --format='%(refname)%00%(refname:short)%00%(ahead-behind:<base>)'`:
 * short ref name → `{ ahead, behind }`. Symbolic `<remote>/HEAD` aliases are dropped, as in
 * `parseRefList`.
 */
export function parseAheadBehindRefs(stdout: string): Map<string, { ahead: number; behind: number }> {
  const counts = new Map<string, { ahead: number; behind: number }>();
  for (const line of stdout.split('\n')) {
    const [fullName, name, pair] = line.split('\0');
    if (!fullName || !name || !pair || fullName.endsWith('/HEAD')) {
      continue;
    }
    const [ahead, behind] = pair.split(' ').map((n) => Number.parseInt(n, 10));
    if (ahead !== undefined && behind !== undefined && Number.isFinite(ahead) && Number.isFinite(behind)) {
      counts.set(name, { ahead, behind });
    }
  }
  return counts;
}

/**
 * Parse `git rev-list --left-right --count <base>...<rev>`: `<only in base>\t<only in rev>`, i.e.
 * behind then ahead. Undefined for malformed output.
 */
export function parseLeftRightCount(stdout: string): { ahead: number; behind: number } | undefined {
  const [behind, ahead] = stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  return ahead !== undefined && behind !== undefined && Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : undefined;
}

/** Parse `git log -z --format=COMMIT_LOG_FORMAT`; malformed records are skipped. */
export function parseCommitLog(stdout: string): CommitEntry[] {
  const commits: CommitEntry[] = [];
  for (const record of stdout.split('\0')) {
    const [sha, parents, author, authoredUnix, ...subjectParts] = record.replace(/^\n/, '').split('\x1f');
    const authoredAt = unixSecondsToMs(authoredUnix);
    if (!sha || parents === undefined || author === undefined || authoredAt === undefined) {
      continue;
    }
    commits.push({
      sha,
      parents: parents.split(' ').filter((p) => p.length > 0),
      author,
      authoredAt,
      subject: subjectParts.join('\x1f'),
    });
  }
  return commits;
}

/**
 * Parse `git ls-tree -r -z <rev> -- <paths>` into path → object ID. Each record is
 * `<mode> SP <type> SP <object> TAB <path>\0`; the path may contain spaces and tabs.
 */
export function parseLsTreeZ(stdout: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const id = record.slice(0, tab).split(' ')[2];
    const filePath = record.slice(tab + 1);
    if (id && filePath) {
      ids.set(filePath, id);
    }
  }
  return ids;
}

/**
 * Line counts for a file that git has no diff for (an untracked file), from its bytes. Matches
 * git's conventions: a NUL byte in the first 8000 bytes means binary, and a final line without a
 * trailing newline still counts as a line.
 */
export function lineStatsOfContent(content: Uint8Array): LineStats {
  const probeEnd = Math.min(content.length, 8000);
  for (let i = 0; i < probeEnd; i++) {
    if (content[i] === 0) {
      return { added: 0, deleted: 0, binary: true };
    }
  }
  let lines = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0a) {
      lines++;
    }
  }
  if (content.length > 0 && content[content.length - 1] !== 0x0a) {
    lines++;
  }
  return { added: lines, deleted: 0, binary: false };
}

function statusForLetter(letter: string): FileStatus | undefined {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
    case 'T':
    case 'U':
      return 'modified';
    default:
      return undefined;
  }
}

/**
 * Count the entries of `git status --porcelain=v1 -z`: one per uncommitted path (staged, unstaged
 * or untracked). Each record is `XY <path>\0`; renames and copies (`R`/`C` in X or Y) carry an
 * extra `<origPath>\0` token, which must be skipped, not counted.
 */
export function countStatusEntries(stdout: string): number {
  const tokens = stdout.split('\0');
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const record = tokens[i];
    if (!record) {
      continue;
    }
    count++;
    const x = record[0];
    const y = record[1];
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      i++;
    }
  }
  return count;
}

/** Split NUL-terminated output (`git ls-files -z`) into its non-empty entries. */
export function parseNulList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/**
 * Parse `git worktree list --porcelain`: blank-line-separated blocks, each starting with
 * `worktree <path>` followed by attribute lines (`HEAD`, `branch`, `detached`, `bare`, `prunable`).
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: { -readonly [K in keyof WorktreeEntry]: WorktreeEntry[K] }[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      entries.push({ path: line.slice('worktree '.length), detached: false, bare: false, prunable: false });
      continue;
    }
    const current = entries[entries.length - 1];
    // Attribute lines before the first `worktree` line cannot be attributed; ignore them.
    if (current === undefined) {
      continue;
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  return entries;
}

/**
 * Parse `git for-each-ref --format=REF_LIST_FORMAT refs/heads refs/remotes`.
 * Symbolic `refs/remotes/<remote>/HEAD` entries are dropped: they only alias another remote branch.
 */
export function parseRefList(stdout: string): RefEntry[] {
  const refs: RefEntry[] = [];
  for (const line of stdout.split('\n')) {
    const [fullName, name, sha, upstream, headMark, committedUnix] = line.split('\0');
    if (!fullName || !name || fullName.endsWith('/HEAD')) {
      continue;
    }
    const kind = fullName.startsWith('refs/heads/') ? 'local' : fullName.startsWith('refs/remotes/') ? 'remote' : undefined;
    if (kind === undefined) {
      continue;
    }
    refs.push({
      name,
      kind,
      sha: sha ?? '',
      upstream: upstream ? upstream : undefined,
      isHead: headMark === '*',
      committedAt: unixSecondsToMs(committedUnix),
    });
  }
  return refs;
}

/**
 * Parse `git show -s --format='%H %ct' <sha>...` into SHA → committer date (ms since epoch).
 * git prints each distinct commit once, so several worktrees on the same commit share an entry.
 */
export function parseCommitDates(stdout: string): Map<string, number> {
  const dates = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const [sha, seconds] = line.trim().split(' ');
    const ms = unixSecondsToMs(seconds);
    if (sha && ms !== undefined) {
      dates.set(sha, ms);
    }
  }
  return dates;
}

function unixSecondsToMs(value: string | undefined): number | undefined {
  const seconds = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
