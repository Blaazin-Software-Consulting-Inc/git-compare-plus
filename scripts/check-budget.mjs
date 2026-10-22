/**
 * Fails (exit 1) when the packaged extension grows past its size budget. Run by `npm run budget`
 * after `npm run package`, locally and in CI, so "lightweight" stays a measured claim.
 *
 * Budgets are deliberately well above today's sizes (bundle ~83 KB, package ~55 KB at 0.9.0):
 * they catch an accidental dependency or asset, not normal feature growth. Raise them in a
 * reviewed change, never to get a build through.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = 1024;
const BUDGETS = [
  { label: 'bundle (dist/extension.js, production)', file: 'dist/extension.js', limit: 250 * KB },
  { label: 'package (.vsix)', file: readdirSync('.').find((f) => f.endsWith('.vsix')), limit: 500 * KB },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
for (const { label, file, limit } of BUDGETS) {
  if (file === undefined) {
    process.stderr.write(`budget: no .vsix found; run npm run package first\n`);
    failed = true;
    continue;
  }
  const size = statSync(join(root, file)).size;
  const ok = size <= limit;
  failed ||= !ok;
  process.stdout.write(`budget: ${ok ? 'ok  ' : 'OVER'} ${label}: ${(size / KB).toFixed(1)} KB of ${limit / KB} KB\n`);
}
process.exit(failed ? 1 : 0);
