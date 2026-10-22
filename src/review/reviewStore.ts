/**
 * reviewStore — remembers which file diffs the user marked as reviewed.
 *
 * A mark is stored per repo (`.git` common dir, so it applies in every worktree) as
 * `<path>\0<fingerprint>` → when it was marked (ms since epoch). The fingerprint
 * (fingerprints.ts) pins the mark to exact content on both sides, so:
 *   - editing the file, or the base moving under it, makes the mark lapse (GitHub "Viewed" style);
 *   - the same diff seen from another comparison (another worktree with identical content, or the
 *     same file after it was committed unchanged) is still reviewed.
 *
 * Lapsed marks are never matched again but stay stored; to keep workspace state bounded, each repo
 * keeps its MAX_MARKS_PER_REPO most recent marks.
 *
 * Persisted in the workspace Memento (per workspace, not synced). Malformed data is ignored, as in
 * baseStore.ts. Pure apart from the injected store; unit-tested in test/reviewStore.test.ts.
 */
import type { KeyValueStore } from '../baseStore';

const STORAGE_KEY = 'gitComparePlus.reviewedByRepo';
// Plenty for several long-lived worktrees' worth of reviews; ~150 bytes each → well under 1 MB.
const MAX_MARKS_PER_REPO = 5000;

/** Marks for one repo: entry key → marked-at (ms since epoch). */
type RepoMarks = Record<string, number>;

/** One file's mark change. */
export interface ReviewMark {
  readonly path: string;
  readonly fingerprint: string;
}

/** Persisted "reviewed" marks. */
export class ReviewStore {
  constructor(private readonly store: KeyValueStore) {}

  /** True when this exact diff (path + fingerprint) was marked reviewed in this repo. */
  isReviewed(commonDir: string, path: string, fingerprint: string | undefined): boolean {
    if (fingerprint === undefined) {
      return false;
    }
    return typeof this.repoMarks(commonDir)[entryKey(path, fingerprint)] === 'number';
  }

  /**
   * Mark or unmark several files of one repo in a single write.
   * @param now - timestamp for new marks (injected for tests).
   */
  async set(commonDir: string, marks: readonly ReviewMark[], reviewed: boolean, now: number): Promise<void> {
    if (marks.length === 0) {
      return;
    }
    const repo: RepoMarks = { ...this.repoMarks(commonDir) };
    for (const mark of marks) {
      const key = entryKey(mark.path, mark.fingerprint);
      if (reviewed) {
        repo[key] = now;
      } else {
        delete repo[key];
      }
    }
    await this.store.update(STORAGE_KEY, { ...this.all(), [commonDir]: pruneOldest(repo) });
  }

  private repoMarks(commonDir: string): RepoMarks {
    const value = this.all()[commonDir];
    return typeof value === 'object' && value !== null ? (value as RepoMarks) : {};
  }

  private all(): Record<string, unknown> {
    const value = this.store.get(STORAGE_KEY);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  }
}

// NUL cannot occur in a git path or a fingerprint, so the key is unambiguous.
function entryKey(path: string, fingerprint: string): string {
  return `${path}\0${fingerprint}`;
}

// Sorting only happens on writes past the cap, which are rare; reads stay O(1).
function pruneOldest(repo: RepoMarks): RepoMarks {
  const entries = Object.entries(repo).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  if (entries.length <= MAX_MARKS_PER_REPO) {
    return Object.fromEntries(entries);
  }
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_MARKS_PER_REPO));
}
