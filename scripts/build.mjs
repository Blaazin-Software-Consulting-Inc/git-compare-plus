/**
 * Bundles the extension into one file, dist/extension.js, with esbuild.
 *
 * Why bundle: one file loads faster than ~30 separate modules (fewer file reads when VS Code
 * activates the extension) and makes the package size easy to budget (scripts/check-budget.mjs).
 * Type checking is separate (`tsc --noEmit` in `npm run build`); esbuild only strips types.
 *
 * `vscode` is provided by the editor at runtime, so it stays external. Target node20: VS Code
 * 1.90, the oldest version supported (package.json engines), runs extensions on Node 20.
 *
 * Usage: node scripts/build.mjs [--production]   (--production minifies, no source map)
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');

// Clear the old per-module output (tsc wrote one file per source file) so nothing stale ships.
rmSync(join(root, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [join(root, 'src', 'extension.ts')],
  outfile: join(root, 'dist', 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'warning',
});
