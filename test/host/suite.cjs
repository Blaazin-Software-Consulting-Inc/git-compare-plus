/**
 * Runs inside the VS Code extension host (see runHost.mjs). Plain CommonJS with Node's assert,
 * so it needs no test framework inside the editor. Rejecting fails the run.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// Generous for slow CI machines; today's local measurement is printed on every run.
const ACTIVATION_BUDGET_MS = 3000;

exports.run = async function run() {
  const manifest = require(path.join(__dirname, '..', '..', 'package.json'));
  const id = `${manifest.publisher}.${manifest.name}`;
  const extension = vscode.extensions.getExtension(id);
  assert.ok(extension, `extension ${id} is not installed in the test host`);
  // Never during startup: the only activation event is onStartupFinished (blame must be ready
  // once a file is open, without delaying the editor's start).
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished'], 'activation events changed: check they cannot delay startup');

  const api = await extension.activate();
  // activate() reports its own duration; by now it has usually already run after startup.
  const activationMs = api.activationMs;
  assert.equal(typeof activationMs, 'number', 'activate() did not report its duration');
  process.stdout.write(`host smoke: activate() took ${activationMs} ms (budget ${ACTIVATION_BUDGET_MS} ms)\n`);
  assert.ok(activationMs <= ACTIVATION_BUDGET_MS, `activation took ${activationMs} ms, over the ${ACTIVATION_BUDGET_MS} ms budget`);

  // Open in Source Control adds a worktree that Source Control does not list yet to the editor's
  // own Source Control view, through the git extension's API.
  // Same folder whatever the spelling: long names, and on Windows any separator or letter case
  // (Source Control reports `c:\…`, git `C:/…`).
  const canonical = (p) => {
    const resolved = fs.realpathSync.native(p);
    return process.platform === 'win32' ? resolved.replace(/\//g, '\\').toLowerCase() : resolved;
  };
  const linked = canonical(process.env.HOST_SMOKE_LINKED);
  const repoRoot = fs.realpathSync.native(process.env.HOST_SMOKE_REPO);
  const gitApi = vscode.extensions.getExtension('vscode.git').exports.getAPI(1);
  const listed = () => gitApi.repositories.map((r) => r.rootUri.fsPath);
  const isOpen = () => listed().some((root) => canonical(root) === linked);
  assert.equal(isOpen(), false, 'the linked worktree was already in Source Control');
  await vscode.commands.executeCommand('gitComparePlus.openInSourceControl', {
    kind: 'worktree',
    repo: { name: path.basename(repoRoot), root: repoRoot, commonDir: path.join(repoRoot, '.git') },
    worktree: { path: fs.realpathSync.native(process.env.HOST_SMOKE_LINKED), branch: 'side', detached: false, bare: false, prunable: false },
    isMain: false,
  });
  // Source Control adds the repository asynchronously after the call returns.
  for (let waited = 0; !isOpen() && waited < 5000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(isOpen(), true, `Open in Source Control did not add ${linked}; Source Control lists: ${listed().join(', ') || 'nothing'}`);
  process.stdout.write('host smoke: Open in Source Control added the linked worktree\n');

  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = manifest.contributes.commands.map((c) => c.command).filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `contributed commands not registered: ${missing.join(', ')}`);
};
