/**
 * Takes the README / Marketplace screenshots: `npm run screenshots` (after `npm run build`).
 *
 * 1. Sets up a demo scene in a clone of expressjs/express (MIT) at a pinned tag, in .bench/express:
 *    a feature branch with a few commits checked out in a linked worktree with uncommitted edits,
 *    a second branch not checked out, and a stash. All demo commits are by "Demo User" and are
 *    local only; nothing is pushed.
 * 2. Opens a throwaway VS Code (downloaded into .vscode-test/, own settings, no other extensions)
 *    with that repo and this extension, and the Chrome DevTools protocol on a local port.
 * 3. Drives each scene: commands through test/screenshots/host.cjs (inside VS Code), clicks and
 *    hovers through DevTools input events, then captures the window as PNG into docs/images/.
 *
 * Nothing from the user's own editor, settings or desktop appears in the shots.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoUrl = 'https://github.com/expressjs/express.git';
const tag = 'v5.1.0';
const repo = join(root, '.bench', 'express');
const worktree = join(repo, '.worktrees', 'feature-links');
const images = join(root, 'docs', 'images');
const port = 9333;
const width = 1440;
const height = 900;

// --- scene ---------------------------------------------------------------------------------

const demoEnv = { ...process.env, GIT_AUTHOR_NAME: 'Demo User', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo User', GIT_COMMITTER_EMAIL: 'demo@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: demoEnv });
const edit = (file, find, replace) => {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(find)) {
    throw new Error(`scene edit: "${find}" not found in ${file}`);
  }
  writeFileSync(file, text.replace(find, replace));
};
const append = (file, text) => writeFileSync(file, readFileSync(file, 'utf8') + text);

function prepareScene() {
  mkdirSync(join(root, '.bench'), { recursive: true });
  if (!existsSync(join(repo, '.git'))) {
    process.stdout.write(`Cloning ${repoUrl} (once)…\n`);
    execFileSync('git', ['clone', '--quiet', repoUrl, repo], { stdio: 'inherit' });
  }
  // Reset to a known state: main = the pinned tag, origin/master pointed at it, no demo branches.
  if (existsSync(worktree)) {
    git(repo, 'worktree', 'remove', '--force', worktree);
  }
  git(repo, 'worktree', 'prune');
  git(repo, 'checkout', '--quiet', '--force', '-B', 'main', tag);
  git(repo, 'clean', '-fdq');
  git(repo, 'stash', 'clear');
  for (const branch of ['feature/links-cache', 'fix/etag-weak']) {
    try {
      execFileSync('git', ['branch', '-D', branch], { cwd: repo, stdio: 'ignore' });
    } catch {
      // Expected on the first run: the demo branch does not exist yet.
    }
  }
  git(repo, 'update-ref', 'refs/remotes/origin/master', tag);
  git(repo, 'remote', 'set-head', 'origin', 'master');
  // "Fetched just now", so the repo row is not flagged as stale.
  writeFileSync(join(repo, '.git', 'FETCH_HEAD'), '');
  // The worktree lives inside the repo (short path in the views); keep it out of `git status`.
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.worktrees/\n');

  // feature/links-cache: three commits, checked out in a linked worktree with uncommitted edits.
  git(repo, 'worktree', 'add', '--quiet', '-b', 'feature/links-cache', worktree, tag);
  edit(join(worktree, 'lib/response.js'), 'res.links = function(links) {', 'res.links = function(links) {\n  // Merge with any Link header set earlier instead of replacing it.');
  git(worktree, 'commit', '--quiet', '-am', 'Merge res.links() with an existing Link header');
  append(join(worktree, 'test/res.links.js'), "\n// Demo: links are merged with an earlier Link header.\n");
  git(worktree, 'commit', '--quiet', '-am', 'Test merging Link headers');
  edit(join(worktree, 'Readme.md'), '## Contributing', '## Links\n\n`res.links()` now merges with a Link header set earlier.\n\n## Contributing');
  git(worktree, 'commit', '--quiet', '-am', 'Document res.links() merging');
  edit(join(worktree, 'lib/application.js'), 'app.init = function init() {', 'app.init = function init() {\n  // Demo: uncommitted edit');
  append(join(worktree, 'lib/response.js'), '\n// Demo: work in progress\n');
  writeFileSync(join(worktree, 'lib/links.js'), "'use strict';\n\n/** Demo: a new, untracked file. */\nmodule.exports = function formatLinks(links) {\n  return Object.keys(links).map((rel) => `<${links[rel]}>; rel=\"${rel}\"`).join(', ');\n};\n");

  // fix/etag-weak: two commits, not checked out anywhere.
  git(repo, 'branch', 'fix/etag-weak', tag);
  git(repo, 'checkout', '--quiet', 'fix/etag-weak');
  edit(join(repo, 'lib/utils.js'), 'exports.etag', '// Demo: strong ETags by default\nexports.etag');
  git(repo, 'commit', '--quiet', '-am', 'Use strong ETags by default');
  append(join(repo, 'lib/utils.js'), '\n// Demo: follow-up\n');
  git(repo, 'commit', '--quiet', '-am', 'Explain the ETag default');
  git(repo, 'checkout', '--quiet', 'main');

  // A stash on main.
  append(join(repo, 'History.md'), '\n<!-- Demo: release notes draft -->\n');
  git(repo, 'stash', 'push', '--quiet', '-m', 'Release notes draft');
}

// --- DevTools --------------------------------------------------------------------------------

class Devtools {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Devtools(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (waiter !== undefined) {
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          waiter.reject(new Error(`${message.error.message} (${waiter.method})`));
        } else {
          waiter.resolve(message.result);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) {
      throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
  }

  close() {
    this.socket.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, check, timeoutMs = 30_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(200);
  }
}

// --- the editor --------------------------------------------------------------------------------

function makeRpc(dir) {
  let next = 0;
  return async (request) => {
    const n = next++;
    writeFileSync(join(dir, `request-${n}.json`), JSON.stringify(request));
    const responseFile = join(dir, `response-${n}.json`);
    await waitFor(`response to ${JSON.stringify(request).slice(0, 80)}`, () => existsSync(responseFile));
    const response = JSON.parse(readFileSync(responseFile, 'utf8'));
    if (!response.ok) {
      throw new Error(`${request.op} ${request.id ?? request.path}: ${response.error}`);
    }
  };
}

/** Centre of the first element matching `find` (JS returning an Element), in CSS pixels. */
async function centreOf(page, what, find) {
  return waitFor(what, () =>
    page.evaluate(`(() => { const el = (${find})(); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`),
  );
}

async function click(page, what, find, modifiers = 0) {
  const { x, y } = await centreOf(page, what, find);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
  await sleep(400);
}

async function key(page, keyName, code, keyCode) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: keyCode });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: keyCode });
  await sleep(300);
}

// Finders for the workbench DOM (run in the page). Rows are found by their visible label.
const row = (pane, label) =>
  `() => { const panes = [...document.querySelectorAll('.pane')]; const p = panes.find((x) => x.querySelector('.pane-header')?.textContent?.includes(${JSON.stringify(pane)})); return [...(p?.querySelectorAll('.monaco-list-row') ?? [])].find((r) => r.querySelector('.label-name, .monaco-highlighted-label')?.textContent?.trim() === ${JSON.stringify(label)}) ?? null; }`;
const checkboxIn = (pane, label) => `() => (${row(pane, label)})()?.querySelector('.custom-view-tree-node-item-checkbox, [role=checkbox]') ?? null`;
const twistieIn = (pane, label) => `() => (${row(pane, label)})()?.querySelector('.monaco-tl-twistie') ?? null`;

/** @param sidebarOnly - crop to the activity bar + sidebar, for shots about the sidebar alone. */
async function capture(page, name, sidebarOnly = false) {
  await sleep(800);
  // Without the window's title bar: it reads "[Extension Development Host]", which users never see.
  const top = await page.evaluate(`document.querySelector('.part.titlebar')?.getBoundingClientRect().height ?? 0`);
  const right = sidebarOnly ? await page.evaluate(`document.querySelector('.part.sidebar')?.getBoundingClientRect().right ?? ${width}`) : width;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: top, width: right, height: height - top, scale: 1 } });
  writeFileSync(join(images, `${name}.png`), Buffer.from(data, 'base64'));
  process.stdout.write(`  docs/images/${name}.png\n`);
}

async function drive(rpcDir) {
  await waitFor('VS Code to start', () => existsSync(join(rpcDir, 'ready')), 120_000);
  const targets = await waitFor('the DevTools port', async () => {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    } catch {
      return null;
    }
  });
  const workbench = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (workbench === undefined) {
    throw new Error('workbench page not found');
  }
  const page = await Devtools.connect(workbench.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  // Electron does not support resizing its window over DevTools; emulating the viewport gives the
  // same fixed layout (VS Code relayouts on the resize this causes), at 2× for sharp images.
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await sleep(1000);
  const rpc = makeRpc(rpcDir);
  // Every shot without notifications (e.g. "extensions are temporarily disabled" from this setup).
  const shot = async (name, sidebarOnly = false) => {
    await rpc({ op: 'command', id: 'notifications.clearAll' });
    await capture(page, name, sidebarOnly);
  };
  const commonDir = realpathSync(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  const repoInfo = { name: 'express', root: realpathSync(repo), commonDir };
  const head = git(worktree, 'rev-parse', 'HEAD').trim();

  await rpc({ op: 'command', id: 'workbench.view.extension.gitComparePlus' });
  await sleep(3000);

  // 1. Changes: the worktree with edits against origin/master; two files ticked; a diff open.
  await rpc({
    op: 'command',
    id: 'gitComparePlus.compare',
    args: [{ kind: 'worktree', repo: repoInfo, worktree: { path: realpathSync(worktree), branch: 'feature/links-cache', head, detached: false, bare: false, prunable: false }, isMain: false }, 'stored'],
  });
  await sleep(2500);
  await click(page, 'Readme.md checkbox', checkboxIn('Changes', 'Readme.md'));
  await click(page, 'res.links.js checkbox', checkboxIn('Changes', 'res.links.js'));
  await click(page, 'response.js row', row('Changes', 'response.js'));
  await sleep(1500);
  await shot('1-changes');

  // 2. Repositories: worktrees, ahead/behind, other branches, stashes expanded.
  await rpc({ op: 'command', id: 'workbench.action.closeAllEditors' });
  await click(page, 'Stashes group', twistieIn('Repositories', 'Stashes'));
  await click(page, 'the stash', twistieIn('Repositories', 'Release notes draft'));
  await sleep(1000);
  await shot('2-repositories', true);

  // 3. The Compare… picker (first question).
  await rpc({ op: 'command', id: 'gitComparePlus.compareTwo', wait: false });
  await sleep(2000);
  await shot('3-compare-picker');
  await key(page, 'Escape', 'Escape', 27);

  // 4. Commits for a selected branch, the newest commit expanded.
  await click(page, 'fix/etag-weak row', row('Repositories', 'fix/etag-weak'));
  await sleep(1500);
  await click(page, 'newest commit', twistieIn('Commits', 'Explain the ETag default'));
  await sleep(1500);
  await shot('4-commits', true);

  // 5. History of lib/response.js, one version's change open.
  await rpc({ op: 'command', id: 'gitComparePlus.history.showFile', args: [{ $uri: join(realpathSync(repo), 'lib/response.js') }] });
  await sleep(2500);
  await click(page, 'a history row', `() => [...document.querySelectorAll('.pane')].find((x) => x.querySelector('.pane-header')?.textContent?.includes('History'))?.querySelectorAll('.monaco-list-row')[1] ?? null`);
  await sleep(1500);
  await shot('5-history');

  // 6. Blame on a line of lib/response.js, with its hover.
  await rpc({ op: 'command', id: 'workbench.action.closeAllEditors' });
  await rpc({ op: 'command', id: 'gitComparePlus.history.close' });
  // Cursor at the end of the line (past the text is clamped to its end), where the note is drawn;
  // then the editor's own Show Hover, which asks the extension's hover provider for that spot.
  await rpc({ op: 'open', path: join(realpathSync(repo), 'lib/response.js'), line: 61, character: 1000 });
  await sleep(2500);
  await rpc({ op: 'command', id: 'editor.action.showHover' });
  await sleep(2000);
  await shot('6-blame');

  page.close();
}

// --- main ----------------------------------------------------------------------------------------

prepareScene();
mkdirSync(images, { recursive: true });
const rpcDir = mkdtempSync(join(tmpdir(), 'gcp-shots-'));
const userData = mkdtempSync(join(tmpdir(), 'gcp-ud-'));
mkdirSync(join(userData, 'User'), { recursive: true });
writeFileSync(
  join(userData, 'User', 'settings.json'),
  JSON.stringify({
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'editor.minimap.enabled': false,
    'window.commandCenter': false,
    'git.openRepositoryInParentFolders': 'never',
    'typescript.disableAutomaticTypeAcquisition': true,
    // VS Code's own blame would show next to ours and confuse the shot.
    'git.blame.statusBarItem.enabled': false,
    'git.blame.editorDecoration.enabled': false,
    'workbench.editor.enablePreview': false,
  }),
);
// Recent VS Code builds name the macOS executable `Code`; @vscode/test-electron 2.4 still expects
// `Electron`. Use whichever exists next to the path it reports.
const reported = await downloadAndUnzipVSCode('stable');
const executable = existsSync(reported) ? reported : join(dirname(reported), 'Code');
try {
  const tests = runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'test', 'screenshots', 'host.cjs'),
    extensionTestsEnv: { GCP_SCREENSHOT_RPC: rpcDir },
    launchArgs: [repo, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`],
  });
  let failure;
  await drive(rpcDir).catch((error) => {
    failure = error;
  });
  writeFileSync(join(rpcDir, 'done'), '');
  await tests;
  if (failure !== undefined) {
    throw failure;
  }
} finally {
  rmSync(rpcDir, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}
