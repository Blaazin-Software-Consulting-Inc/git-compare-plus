/**
 * Runs bench/bench.ts: bundles it with esbuild (it imports the extension's git layer, which has
 * no `vscode` import) into a temporary file and executes it with the same arguments.
 * See bench/bench.ts for what is measured. Usage: npm run bench [-- --check] [-- --json out.json]
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'git-compare-plus-bench-'));
try {
  const outfile = join(scratch, 'bench.cjs');
  await build({
    entryPoints: [join(root, 'bench', 'bench.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning',
    // __dirname in bench.ts must point at bench/, not the scratch folder.
    define: { __dirname: JSON.stringify(join(root, 'bench')) },
  });
  execFileSync(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (error) {
  process.exitCode = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
