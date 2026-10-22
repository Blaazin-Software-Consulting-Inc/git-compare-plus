/**
 * Benchmark: how long the operations a user waits on take, on a large real repository.
 *
 * What is timed is the extension's own code path (GitCli + comparison.ts + friends), exactly as the
 * views call it, minus the editor's drawing. Most of the time is git's; the point is to show what
 * the extension adds on top, and to catch regressions.
 *
 * Repository: git/git, cloned once into .bench/git (about 270 MB; reused on later runs), checked
 * out at a pinned tag so numbers are comparable between runs and machines:
 *   - "two releases": v2.46.0 vs v2.47.0, a large comparison (hundreds of files);
 *   - "worktree with edits": a linked worktree at v2.47.0 with uncommitted and untracked edits,
 *     reviewed against v2.46.0 since the branch point (the everyday case).
 *
 * Each operation runs once to warm git's caches, then RUNS times; the median and slowest are
 * reported. With `--check`, exits 1 if any median is over its CI limit (LIMITS_MS): limits are
 * several times today's numbers, to catch real slowdowns, not noise.
 *
 * Usage (via scripts/bench.mjs): npm run bench [-- --check] [-- --json out.json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAheadBehind } from '../src/aheadBehind';
import { SEARCH_LIMIT, searchArgs } from '../src/commits/commitSearch';
import { COMMIT_LIMIT, runComparisons, type BaseSpec, type CompareMode, type ComparisonRequest } from '../src/comparison';
import { GitCli } from '../src/git/gitCli';
import { HISTORY_LIMIT } from '../src/history/historyModel';
import type { Logger } from '../src/logger';
import { stashFiles } from '../src/stashes';

const REPO_URL = 'https://github.com/git/git.git';
const NEW_TAG = 'v2.47.0';
const OLD_TAG = 'v2.46.0';
const RUNS = 5;
// A large, much-changed C file for blame and history (~7,000 lines at v2.47.0).
const BIG_FILE = 'sequencer.c';
// Medians above these fail `--check` (CI). Set at roughly 10× the medians measured on an Apple M5
// Pro (2026-10-22, git 2.53), which leaves room for slower CI runners while still catching a real
// slowdown (an accidental extra history walk, a lost cache, a serialised step).
const LIMITS_MS: Readonly<Record<string, number>> = {
  'Compare two releases (all differences)': 2_000, // measured 149
  'Compare worktree with edits (since branch point)': 4_000, // 363
  'Blame a large file (unsaved text)': 5_000, // 418
  'File history (newest 200)': 3_000, // 256
  'Line history (40 lines)': 7_000, // 669
  'Search commit messages': 1_000, // 21
  'Search by author': 1_000, // 50
  'Search by file path': 3_000, // 289
  'Search changed text (-S)': 20_000, // 1,703
  'Ahead/behind for every branch': 4_000, // 386
  'Repository details (worktrees, branches, default)': 1_000, // 7
  "Stash list + one stash's files": 1_000, // 16
};

const root = path.join(__dirname, '..');
const benchDir = path.join(root, '.bench');
const repo = path.join(benchDir, 'git');
const worktree = path.join(benchDir, 'git-worktree');
const args = process.argv.slice(2);

// Silent logger: logging cost is not what is measured.
const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const cli = new GitCli('git', quiet);

function git(cwd: string, ...gitArgs: string[]): string {
  return execFileSync('git', gitArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com' },
  });
}

/** Clone once, then put the repo, a worktree with edits, and a few stashes in a known state. */
function prepare(): void {
  mkdirSync(benchDir, { recursive: true });
  if (!existsSync(path.join(repo, '.git'))) {
    process.stdout.write(`Cloning ${REPO_URL} into .bench/git (once; about 270 MB)…\n`);
    execFileSync('git', ['clone', '--quiet', '--no-checkout', REPO_URL, repo], { stdio: 'inherit' });
  }
  git(repo, 'checkout', '--quiet', '--force', '--detach', NEW_TAG);
  git(repo, 'clean', '-fdq');
  git(repo, 'stash', 'clear');
  if (existsSync(worktree)) {
    git(repo, 'worktree', 'remove', '--force', worktree);
  }
  git(repo, 'worktree', 'prune');
  git(repo, 'worktree', 'add', '--quiet', '--detach', worktree, NEW_TAG);
  // Everyday review: a few edited files, one new file, one deleted file.
  for (const file of ['diff.c', 'refs.c', 'sequencer.c', 'builtin/log.c']) {
    writeFileSync(path.join(worktree, file), `${readFileSync(path.join(worktree, file), 'utf8')}\n/* bench edit */\n`);
  }
  writeFileSync(path.join(worktree, 'bench-new-file.c'), 'int bench(void) { return 0; }\n');
  rmSync(path.join(worktree, 'README.md'));
  // Stashes to list: made in the main checkout, then the checkout is reset.
  for (const n of [1, 2, 3]) {
    writeFileSync(path.join(repo, 'diff.c'), `${readFileSync(path.join(repo, 'diff.c'), 'utf8')}\n/* stash ${n} */\n`);
    git(repo, 'stash', 'push', '--quiet', '-m', `bench stash ${n}`);
  }
}

interface Result {
  readonly name: string;
  readonly medianMs: number;
  readonly maxMs: number;
  readonly detail: string;
  readonly limitMs?: number;
}

async function time(name: string, run: () => Promise<string>): Promise<Result> {
  let detail = await run(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const startedAt = process.hrtime.bigint();
    detail = await run();
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const result = { name, medianMs: samples[Math.floor(samples.length / 2)] ?? 0, maxMs: samples[samples.length - 1] ?? 0, detail, limitMs: LIMITS_MS[name] };
  process.stdout.write(`  ${name}: ${result.medianMs.toFixed(0)} ms (slowest ${result.maxMs.toFixed(0)} ms) · ${detail}\n`);
  return result;
}

const repoInfo = { name: 'git', root: repo, commonDir: path.join(repo, '.git') };

async function compare(request: ComparisonRequest, base: BaseSpec, mode: CompareMode): Promise<string> {
  const [result] = await runComparisons(cli, [request], base, mode, { includeUntracked: true, logger: quiet });
  if (result?.outcome !== 'compared') {
    throw new Error(`comparison ${result?.outcome ?? 'missing'}: ${result?.errorMessage ?? ''}`);
  }
  return `${result.files.length} files, ${result.commits?.entries.length ?? 0}${result.commits?.truncated ? '+' : ''} commits`;
}

async function main(): Promise<void> {
  prepare();
  const gitVersion = git(repo, '--version').trim();
  const commitCount = git(repo, 'rev-list', '--count', NEW_TAG).trim();
  const fileCount = git(repo, 'ls-files').split('\n').filter(Boolean).length;
  const bigFileLines = readFileSync(path.join(repo, BIG_FILE), 'utf8').split('\n').length;
  const environment = {
    machine: `${os.cpus()[0]?.model ?? 'unknown CPU'} × ${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}`,
    node: process.version,
    git: gitVersion,
    repo: `git/git at ${NEW_TAG}: ${commitCount} commits, ${fileCount} files`,
  };
  process.stdout.write(`${environment.machine}\n${environment.git} · node ${environment.node}\n${environment.repo}\n\n`);

  const results: Result[] = [];
  results.push(
    await time('Compare two releases (all differences)', () =>
      compare({ repo: repoInfo, subject: { kind: 'ref', ref: NEW_TAG, label: NEW_TAG, refKind: 'tag' } }, { kind: 'ref', ref: OLD_TAG, refKind: 'tag' }, 'direct'),
    ),
  );
  results.push(
    await time('Compare worktree with edits (since branch point)', () =>
      compare({ repo: repoInfo, subject: { kind: 'worktree', root: worktree, label: 'bench', includeUncommitted: true } }, { kind: 'ref', ref: OLD_TAG, refKind: 'tag' }, 'merge-base'),
    ),
  );
  const bigFileText = readFileSync(path.join(worktree, BIG_FILE), 'utf8');
  results.push(
    await time('Blame a large file (unsaved text)', async () => {
      const lines = await cli.blame(worktree, BIG_FILE, `${bigFileText}\n/* unsaved */\n`);
      return `${lines?.length ?? 0} lines (${bigFileLines} in the file)`;
    }),
  );
  results.push(
    await time('File history (newest 200)', async () => `${(await cli.fileHistory(repo, BIG_FILE, HISTORY_LIMIT + 1)).length - 1}+ commits`),
  );
  results.push(
    await time('Line history (40 lines)', async () => `${(await cli.lineHistory(repo, BIG_FILE, 200, 240, HISTORY_LIMIT + 1)).length} commits`),
  );
  const search = async (kind: 'message' | 'author' | 'file' | 'code', text: string) =>
    `${(await cli.searchCommits(repo, searchArgs({ kind, text }) ?? [], SEARCH_LIMIT + 1)).length} found (limit ${SEARCH_LIMIT + 1})`;
  results.push(await time('Search commit messages', () => search('message', 'fix')));
  results.push(await time('Search by author', () => search('author', 'peff')));
  results.push(await time('Search by file path', () => search('file', 'refs/')));
  results.push(await time('Search changed text (-S)', () => search('code', 'strbuf_addf')));
  results.push(
    await time('Ahead/behind for every branch', async () => {
      const [refs, worktrees] = await Promise.all([cli.refs(repo), cli.worktrees(repo)]);
      const counts = await loadAheadBehind(cli, repo, { label: OLD_TAG, commitish: OLD_TAG }, refs, worktrees, quiet);
      return `${refs.length} refs, ${counts?.byRef.size ?? 0} counted`;
    }),
  );
  results.push(
    await time('Repository details (worktrees, branches, default)', async () => {
      const [worktrees, refs] = await Promise.all([cli.worktrees(repo), cli.refs(repo), cli.lastFetchedAt(repo), cli.defaultBranch(repo)]);
      return `${worktrees.length} worktrees, ${refs.length} refs`;
    }),
  );
  results.push(
    await time("Stash list + one stash's files", async () => {
      const stashes = await cli.stashes(repo);
      const first = stashes[0];
      const files = first === undefined ? [] : await stashFiles(cli, repo, first);
      return `${stashes.length} stashes, ${files.length} files in the newest`;
    }),
  );
  process.stdout.write(`\nComparison commit lists stop at ${COMMIT_LIMIT}; histories and searches at ${HISTORY_LIMIT} / ${SEARCH_LIMIT}.\n`);

  const jsonIndex = args.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify({ environment, runs: RUNS, results }, null, 2)}\n`);
  }
  if (args.includes('--check')) {
    const over = results.filter((r) => r.limitMs !== undefined && r.medianMs > r.limitMs);
    for (const r of over) {
      process.stderr.write(`OVER LIMIT: ${r.name}: median ${r.medianMs.toFixed(0)} ms > ${r.limitMs} ms\n`);
    }
    process.exitCode = over.length > 0 ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`bench failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
