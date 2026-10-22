/**
 * defaultBranch — which branch counts as a repo's "default branch": the side every one-click
 * comparison, the ahead/behind counts, the branch ordering and the "unmerged commits" check in
 * Delete Branch are measured against.
 *
 * Why configurable: the automatic choice is `<remote>/HEAD`, and `origin` is only right for a
 * plain clone. In a fork workflow `origin` is the user's fork and the real project is `upstream`,
 * so `origin/HEAD` points at a stale copy. Two settings cover that:
 *   - `gitComparePlus.remote`: the remote whose HEAD is the default (`upstream` for forks).
 *   - `gitComparePlus.defaultBranches`: per-repo overrides, keyed by the repo's folder name or the
 *     absolute path of its main worktree, e.g. `{ "api": "upstream/develop" }`.
 *
 * Resolution order (GitCli.defaultBranch): override → `<remote>/HEAD` → the first existing of
 * `<remote>/main`, `<remote>/master`, `main`, `master`.
 *
 * Pure; unit-tested in test/defaultBranch.test.ts.
 */
import * as path from 'node:path';
import { samePath } from './paths';

/** The two settings, as read from the configuration. */
export interface DefaultBranchSettings {
  /** Remote name; `origin` unless the user changed it. */
  readonly remote: string;
  /** Repo folder name or absolute main-worktree path → ref to use as that repo's default branch. */
  readonly overrides: Readonly<Record<string, string>>;
}

/** What GitCli uses when no settings are supplied (tests, or before configuration is read). */
export const DEFAULT_BRANCH_SETTINGS: DefaultBranchSettings = { remote: 'origin', overrides: {} };

/**
 * The override for a repo, if any. An absolute-path key wins over a folder-name key, so two repos
 * with the same folder name can still be told apart.
 * @param mainWorktree - absolute path of the repo's main worktree.
 */
export function overrideFor(settings: DefaultBranchSettings, mainWorktree: string): string | undefined {
  const byPath = Object.entries(settings.overrides).find(([key]) => path.isAbsolute(key) && samePath(key, mainWorktree));
  if (byPath !== undefined) {
    return nonEmpty(byPath[1]);
  }
  return nonEmpty(settings.overrides[path.basename(mainWorktree)]);
}

/** Refs tried, in order, when `<remote>/HEAD` is not set. */
export function fallbackCandidates(remote: string): string[] {
  return [`${remote}/main`, `${remote}/master`, 'main', 'master'];
}

/**
 * Settings from untyped configuration values: anything that is not a non-empty string (remote) or
 * a string → string map (overrides) is ignored rather than trusted.
 */
export function parseDefaultBranchSettings(remote: unknown, overrides: unknown): DefaultBranchSettings {
  const cleanRemote = typeof remote === 'string' && remote.trim().length > 0 ? remote.trim() : DEFAULT_BRANCH_SETTINGS.remote;
  const cleanOverrides: Record<string, string> = {};
  if (typeof overrides === 'object' && overrides !== null) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        cleanOverrides[key] = value.trim();
      }
    }
  }
  return { remote: cleanRemote, overrides: cleanOverrides };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}
