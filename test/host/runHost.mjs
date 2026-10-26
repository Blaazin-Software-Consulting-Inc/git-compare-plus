/**
 * Extension-host smoke test: downloads VS Code (the oldest supported version, from package.json
 * `engines`, cached in .vscode-test/), opens a throwaway git repository, and runs
 * test/host/suite.cjs inside the real editor. Run with `npm run test:host` after `npm run build`.
 *
 * What it covers that vitest cannot: the bundle loads in VS Code, activation succeeds against the
 * real built-in git extension, every contributed command is registered, and activation stays
 * within its time budget (suite.cjs).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).engines.vscode.replace(/^[^0-9]*/, '');
const workspace = mkdtempSync(join(tmpdir(), 'host-smoke-'));
const userData = mkdtempSync(join(tmpdir(), 'vsc-'));
const git = (...args) => execFileSync('git', args, { cwd: workspace, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
try {
  git('init', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // A linked worktree inside the window's folder but deeper than git's repository scan (depth 1),
  // so Source Control does not list it until Open in Source Control adds it. Git's API refuses
  // worktrees outside the window's folders on VS Code 1.90 (see GitActions.openInSourceControl).
  const linked = join(workspace, 'nested', 'side');
  writeFileSync(join(workspace, '.git', 'info', 'exclude'), 'nested/\n');
  git('worktree', 'add', '-q', '-b', 'side', linked);
  await runTests({
    version: engine,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test', 'host', 'suite.cjs'),
    extensionTestsEnv: { HOST_SMOKE_REPO: workspace, HOST_SMOKE_LINKED: linked },
    // Other installed extensions stay out of the measurement; built-ins (vscode.git) still load.
    // A short user-data dir: macOS limits socket paths to 103 characters, and the default one
    // inside .vscode-test/ is longer than that in a deep checkout.
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`],
  });
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}
