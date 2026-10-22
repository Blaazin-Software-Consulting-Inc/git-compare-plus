/**
 * paths — path comparison and display shared by the views and settings.
 *
 * Git prints forward-slashed paths on every platform, while Node's `path` and user settings may
 * use backslashes on Windows, where paths are also case-insensitive. Comparing them as strings
 * would treat the same folder as two; `samePath` normalises both sides first.
 *
 * Pure; unit-tested in test/paths.test.ts.
 */
import * as path from 'node:path';

/** True when two absolute paths name the same folder (separators, trailing slash, Windows case). */
export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** True when `target` is one of `candidates` (see `samePath`). */
export function isOneOf(target: string, candidates: readonly string[]): boolean {
  const wanted = normalize(target);
  return candidates.some((candidate) => normalize(candidate) === wanted);
}

/**
 * Short display form: relative to `repoRoot` when inside it (`.claude/worktrees/x`), otherwise
 * with `~` for the home folder.
 */
export function displayPath(repoRoot: string, target: string): string {
  const relative = path.relative(repoRoot, target);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  const home = process.env.HOME;
  return home !== undefined && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

function normalize(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
