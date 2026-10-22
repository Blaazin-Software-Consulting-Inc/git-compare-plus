/**
 * Runs inside the VS Code extension host (see runHost.mjs). Plain CommonJS with Node's assert,
 * so it needs no test framework inside the editor. Rejecting fails the run.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

// Generous for slow CI machines; today's local measurement is printed on every run. Includes
// activating the built-in git extension, which this extension depends on.
const ACTIVATION_BUDGET_MS = 3000;

exports.run = async function run() {
  const manifest = require(path.join(__dirname, '..', '..', 'package.json'));
  const id = `${manifest.publisher}.${manifest.name}`;
  const extension = vscode.extensions.getExtension(id);
  assert.ok(extension, `extension ${id} is not installed in the test host`);
  // Lazy loading: nothing in the manifest asks VS Code to activate at startup.
  assert.equal(extension.isActive, false, 'the extension activated before anything used it');

  const startedAt = Date.now();
  await extension.activate();
  const activationMs = Date.now() - startedAt;
  process.stdout.write(`host smoke: activation took ${activationMs} ms (budget ${ACTIVATION_BUDGET_MS} ms)\n`);
  assert.ok(activationMs <= ACTIVATION_BUDGET_MS, `activation took ${activationMs} ms, over the ${ACTIVATION_BUDGET_MS} ms budget`);

  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = manifest.contributes.commands.map((c) => c.command).filter((command) => !registered.has(command));
  assert.deepEqual(missing, [], `contributed commands not registered: ${missing.join(', ')}`);
};
