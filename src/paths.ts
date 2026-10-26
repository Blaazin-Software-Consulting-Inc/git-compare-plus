/**
 * paths — path comparison and display shared by the views and settings.
 *
 * Git prints forward-slashed paths on every platform, while Node's `path` and user settings may
 * use backslashes on Windows, where paths are also case-insensitive. Comparing them as strings
 * would treat the same folder as two; `samePath` normalises both sides first.
 *
 * Pure; unit-tested in test/paths.test.ts.
 */
import { homedir } from 'node:os';
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
 * with `~` for the home folder. Always forward-slashed, as git prints paths, so a Windows window
 * never mixes `.wt\x` with git's `C:/repo/.wt/y`.
 */
export function displayPath(repoRoot: string, target: string): string {
  const relative = path.relative(repoRoot, target);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return slashes(relative);
  }
  const shown = slashes(target);
  // os.homedir(), not $HOME: Windows sets USERPROFILE instead.
  const home = slashes(homedir()).replace(/\/+$/, '');
  const rest = shown.slice(home.length);
  // Inside home: the prefix is the same folder (case-insensitive on Windows) and ends at a
  // separator, so `/home/ann2` is not shown as `~2` for home `/home/ann`.
  const insideHome = home !== '' && samePath(shown.slice(0, home.length), home) && (rest === '' || rest.startsWith('/'));
  return insideHome ? `~${rest}` : shown;
}

function slashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function normalize(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
