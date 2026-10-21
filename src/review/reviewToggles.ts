/**
 * reviewToggles — turns a batch of checkbox changes from the Changes view into ReviewStore writes.
 *
 * VS Code reports several toggles in one event (e.g. a multi-selection checked at once), possibly
 * across repos and in both directions. Grouping them gives one store write per repo and direction,
 * and separates the files that cannot be marked because their fingerprint is unknown.
 *
 * Pure; unit-tested in test/reviewStore.test.ts.
 */
import type { ReviewMark } from './reviewStore';

/** One checkbox change, reduced to what the store needs. */
export interface ReviewToggle {
  readonly commonDir: string;
  readonly path: string;
  /** Undefined when the comparison could not identify the file's content. */
  readonly fingerprint: string | undefined;
  readonly checked: boolean;
}

/** Store writes grouped per repo, plus the paths that could not be marked. */
export interface GroupedToggles {
  readonly byRepo: ReadonlyMap<string, { readonly reviewed: ReviewMark[]; readonly unreviewed: ReviewMark[] }>;
  /** Paths checked without a fingerprint. Unchecking such a file needs no write: it was never marked. */
  readonly unmarkable: readonly string[];
}

/** Group checkbox changes by repo and direction. */
export function groupReviewToggles(toggles: readonly ReviewToggle[]): GroupedToggles {
  const byRepo = new Map<string, { reviewed: ReviewMark[]; unreviewed: ReviewMark[] }>();
  const unmarkable: string[] = [];
  for (const toggle of toggles) {
    if (toggle.fingerprint === undefined) {
      if (toggle.checked) {
        unmarkable.push(toggle.path);
      }
      continue;
    }
    let repo = byRepo.get(toggle.commonDir);
    if (repo === undefined) {
      repo = { reviewed: [], unreviewed: [] };
      byRepo.set(toggle.commonDir, repo);
    }
    (toggle.checked ? repo.reviewed : repo.unreviewed).push({ path: toggle.path, fingerprint: toggle.fingerprint });
  }
  return { byRepo, unmarkable };
}
