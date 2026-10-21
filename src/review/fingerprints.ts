/**
 * fingerprints — identity of each file's diff, so a "reviewed" mark applies to exactly the
 * version the user looked at.
 *
 * A fingerprint is `<left object>><right object>`, using `-` for an empty side (added files have
 * no left, deleted files no right):
 *   - left: the blob at the OLD path in the comparison's base revision (merge base, base commit or
 *     snapshot tree), from `git ls-tree`.
 *   - right: the blob at the path in the subject revision, or, for a working-tree subject, the
 *     git-style hash of the file on disk.
 *
 * Why blob IDs rather than "revision + path": a revision changes for reasons that do not change
 * the file (an unrelated commit, any edit anywhere in a snapshot base), and would reset every
 * mark. Blob IDs change only when that file's content does, on either side. A file committed
 * unchanged keeps its fingerprint, so a mark survives "commit what I reviewed".
 *
 * Best-effort, like line stats: a file whose fingerprint cannot be determined has none and simply
 * cannot be marked (the view says so). The comparison itself never fails because of it.
 *
 * Pure apart from the injected port; unit-tested in test/fingerprints.test.ts.
 */
import type { ChangedFile } from '../git/parsers';

/** Git access needed to fingerprint files. Implemented by GitCli. */
export interface FingerprintPort {
  blobIds(cwd: string, revision: string, paths: readonly string[]): Promise<Map<string, string>>;
  hashWorkingFiles(root: string, relativePaths: readonly string[]): Promise<Map<string, string>>;
}

/** Marker for a side with no content (added → no left, deleted → no right). */
const EMPTY_SIDE = '-';

/**
 * Attach `fingerprint` to each file. Two lookups per comparison at most (one per side), however
 * many files there are.
 * @param cwd - where the subject is read (worktree root, or the repo root for a branch subject).
 * @param baseRevision - left side (commit or tree).
 * @param subjectRevision - right side; `undefined` = the working tree at `cwd`.
 * @throws when git fails; the caller (comparison.ts) logs WARN and shows files without fingerprints.
 */
export async function attachFingerprints(
  git: FingerprintPort,
  cwd: string,
  files: readonly ChangedFile[],
  baseRevision: string,
  subjectRevision: string | undefined,
): Promise<ChangedFile[]> {
  const leftPaths = files.filter(hasLeftSide).map((f) => f.oldPath);
  const rightPaths = files.filter(hasRightSide).map((f) => f.path);
  const [left, right] = await Promise.all([
    leftPaths.length === 0 ? new Map<string, string>() : git.blobIds(cwd, baseRevision, leftPaths),
    rightPaths.length === 0
      ? new Map<string, string>()
      : subjectRevision === undefined
        ? git.hashWorkingFiles(cwd, rightPaths)
        : git.blobIds(cwd, subjectRevision, rightPaths),
  ]);
  return files.map((file) => {
    const fingerprint = fingerprintOf(file, left, right);
    return fingerprint === undefined ? file : { ...file, fingerprint };
  });
}

// A side that should exist but was not found (race with an edit, unreadable file) makes the whole
// fingerprint unknown: "-" there would wrongly equal the fingerprint of an add or delete.
function fingerprintOf(file: ChangedFile, left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): string | undefined {
  const leftId = hasLeftSide(file) ? left.get(file.oldPath) : EMPTY_SIDE;
  const rightId = hasRightSide(file) ? right.get(file.path) : EMPTY_SIDE;
  return leftId === undefined || rightId === undefined ? undefined : `${leftId}>${rightId}`;
}

function hasLeftSide(file: ChangedFile): boolean {
  return file.status !== 'added' && file.status !== 'untracked';
}

function hasRightSide(file: ChangedFile): boolean {
  return file.status !== 'deleted';
}
