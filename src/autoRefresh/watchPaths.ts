/**
 * watchPaths — which folders the Changes auto-refresh watches, and which file events to ignore.
 *
 * Why watch folders at all: Cursor's git extension only reports changes for repos open in the
 * window. Linked worktrees (`.claude/worktrees/*`, `<repo>.worktrees/*`) usually are not, so edits
 * there would never refresh a comparison of them. The comparison's worktree roots (subject and,
 * if any, base) are watched directly; repos are additionally followed via git events.
 *
 * Ignored paths: git internals (commits/branches are picked up through the repo's git events) and
 * dependency/build output, which churns heavily (`npm install`, builds) and is normally gitignored
 * anyway. Ignoring it only avoids pointless reruns; a rerun is always correct.
 *
 * Pure; unit-tested in test/watchPaths.test.ts.
 */
import * as path from 'node:path';
import type { ComparisonSetup } from '../views/changesHeader';

/** Folder names whose contents never trigger a rerun. */
const IGNORED_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'cdk.out',
  '.aws-sam',
  'target',
]);

/** True when a change at `changedPath` (absolute) under `root` should not trigger a rerun. */
export function isIgnoredChange(root: string, changedPath: string): boolean {
  const relative = path.relative(root, changedPath);
  // Outside the watched root (should not happen; be safe).
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return true;
  }
  return relative.split(path.sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

/** Worktree folders whose files feed the comparison: worktree subjects and a worktree base. */
export function watchedRoots(setup: ComparisonSetup): string[] {
  const roots = setup.requests.flatMap((r) => (r.subject.kind === 'worktree' ? [r.subject.root] : []));
  if (setup.base.kind === 'worktree') {
    roots.push(setup.base.root);
  }
  return [...new Set(roots)].sort();
}

/** `.git` common dirs of every repo in the comparison; git events for these trigger a rerun. */
export function involvedCommonDirs(setup: ComparisonSetup): Set<string> {
  return new Set(setup.requests.map((r) => r.repo.commonDir));
}
