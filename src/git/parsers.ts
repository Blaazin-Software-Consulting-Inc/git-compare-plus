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
}

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
