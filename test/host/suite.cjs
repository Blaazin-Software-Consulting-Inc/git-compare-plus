/**
 * Runs inside the VS Code extension host (see runHost.mjs). Plain CommonJS with Node's assert,
 * so it needs no test framework inside the editor. Rejecting fails the run.
 */
const assert = require('node:assert/strict');
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

  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = manifest.contributes.commands.map((c) => c.command).filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `contributed commands not registered: ${missing.join(', ')}`);
};
