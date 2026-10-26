/**
 * Runs inside the VS Code started by scripts/screenshots.mjs (as its "extension tests"), and does
 * what the runner asks through files in $GCP_SCREENSHOT_RPC: run a command, or open a file at a
 * line. Nothing here asserts anything; it keeps VS Code open until the runner writes `done`.
 *
 * Protocol: the runner writes `request-<n>.json` ({ op, … }); this answers `response-<n>.json`
 * ({ ok, error? }). Command arguments written as { "$uri": "/abs/path" } become file URIs.
 */
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const dir = process.env.GCP_SCREENSHOT_RPC;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function revive(value) {
  if (Array.isArray(value)) {
    return value.map(revive);
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.$uri === 'string') {
      return vscode.Uri.file(value.$uri);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}

async function handle(request) {
  switch (request.op) {
    case 'command': {
      const running = vscode.commands.executeCommand(request.id, ...revive(request.args ?? []));
      // Commands that wait for the user (quick picks) are started, not awaited.
      if (request.wait !== false) {
        await running;
      } else {
        running.then(undefined, () => undefined);
      }
      return;
    }
    case 'open': {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.path));
      const position = new vscode.Position(request.line, request.character ?? 0);
      await vscode.window.showTextDocument(document, { selection: new vscode.Selection(position, position), preview: false });
      return;
    }
    default:
      throw new Error(`unknown op ${request.op}`);
  }
}

exports.run = async function run() {
  await vscode.extensions.getExtension('blaazinsoftware.git-compare-plus')?.activate();
  fs.writeFileSync(path.join(dir, 'ready'), '');
  let next = 0;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'done'))) {
      return;
    }
    const file = path.join(dir, `request-${next}.json`);
    if (!fs.existsSync(file)) {
      await sleep(50);
      continue;
    }
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    let response;
    try {
      await handle(request);
      response = { ok: true };
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    fs.writeFileSync(path.join(dir, `response-${next}.json`), JSON.stringify(response));
    next++;
  }
};
