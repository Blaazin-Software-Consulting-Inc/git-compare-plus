/**
 * repos — folds discovered repository roots into one entry per real repository.
 *
 * Why: the built-in git extension reports every git root it finds, and a linked worktree opened in
 * (or nested inside) the workspace shows up as its own "repository". In this extension a worktree
 * is a child of its repo in the Repositories view, so roots sharing a `.git` common directory are
 * merged and represented by the main worktree.
 *
 * Pure module; unit-tested in test/repos.test.ts. Probing git for each root happens in
 * repoDiscovery.ts.
 */
import * as path from 'node:path';
import type { RepoInfo } from './comparison';

/** What repoDiscovery.ts learned about one discovered root. */
export interface RepoProbe {
  /** The root as reported by the git extension (may be a linked worktree). */
  readonly root: string;
  /** Shared `.git` directory (`git rev-parse --git-common-dir`). */
  readonly commonDir: string;
  /** First entry of `git worktree list` (the main worktree); absent if that call failed. */
  readonly mainWorktree?: string;
}

/**
 * One `RepoInfo` per distinct `commonDir`, in the order each repo was first seen (callers pass
 * roots in workspace-folder order, so the view mirrors the `.code-workspace` order).
 */
export function groupRepos(probes: readonly RepoProbe[]): RepoInfo[] {
  const byCommonDir = new Map<string, RepoInfo>();
  for (const probe of probes) {
    if (byCommonDir.has(probe.commonDir)) {
      continue;
    }
    const root = probe.mainWorktree ?? probe.root;
    byCommonDir.set(probe.commonDir, { name: path.basename(root), root, commonDir: probe.commonDir });
  }
  return [...byCommonDir.values()];
}
