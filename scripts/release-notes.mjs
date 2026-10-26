/**
 * Release gate and notes: checks that a release tag, package.json and CHANGELOG.md agree, then
 * prints (or writes) that version's CHANGELOG entry for the GitHub Release.
 *
 * Why: publishing to the Marketplace and Open VSX cannot be taken back (a published version
 * number can never be reused), so the release workflow runs this first. It refuses a tag that is
 * not `v<package.json version>`, and a CHANGELOG entry that is missing or still `(unreleased)`.
 *
 *   node scripts/release-notes.mjs v1.0.0                     notes to stdout
 *   node scripts/release-notes.mjs v1.0.0 --out notes.md      notes to a file
 *
 * CHANGELOG headings look like `## 1.0.0 (2026-10-26)`; an entry runs to the next `## ` heading.
 * The pure functions are unit-tested in test/releaseNotes.test.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Throws unless `tag` is exactly `v<version>` (no prefix, suffix or other version).
 * @param {string} tag - the pushed git tag, e.g. `v1.0.0` (GITHUB_REF_NAME in the workflow).
 * @param {string} version - package.json `version`.
 */
export function checkTag(tag, version) {
  if (tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match package.json version ${version}: expected v${version}.`);
  }
}

/**
 * The CHANGELOG entry for `version`: its release date and its body (heading line excluded,
 * surrounding blank lines trimmed).
 * @param {string} changelog - CHANGELOG.md contents.
 * @param {string} version - e.g. `1.0.0`.
 * @returns {{ date: string, notes: string }} date as `YYYY-MM-DD`.
 * @throws when there is no `## <version> (...)` heading, when it has no `YYYY-MM-DD` date (an
 *   `(unreleased)` entry must be dated before release), or when the entry is empty.
 */
export function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no "## ${version}" entry.`);
  }
  const date = /^## \S+ \((\d{4}-\d{2}-\d{2})\)$/.exec(lines[start])?.[1];
  if (date === undefined) {
    throw new Error(`CHANGELOG.md entry "${lines[start]}" has no release date: write it as "## ${version} (YYYY-MM-DD)".`);
  }
  // The entry ends at the next version heading (`## `), not at its own `### ` sections.
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const notes = lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim();
  if (notes.length === 0) {
    throw new Error(`CHANGELOG.md entry for ${version} is empty.`);
  }
  return { date, notes };
}

function main(argv) {
  const [tag, flag, out] = argv;
  if (tag === undefined || (flag !== undefined && (flag !== '--out' || out === undefined))) {
    throw new Error('Usage: node scripts/release-notes.mjs <tag> [--out <file>]');
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  checkTag(tag, version);
  const { date, notes } = releaseNotes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (out === undefined) {
    process.stdout.write(`${notes}\n`);
  } else {
    writeFileSync(out, `${notes}\n`);
  }
  process.stderr.write(`release: ${tag} matches package.json and CHANGELOG.md (released ${date})\n`);
}

// Run only as a script, not when the test imports the functions above.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
