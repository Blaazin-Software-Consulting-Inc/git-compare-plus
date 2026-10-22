/**
 * Writes media/diff-bar/<light|dark>/<added>-<removed>.svg from src/views/diffBar.ts.
 * Run with `npm run generate:icons`. test/diffBar.test.ts fails if the committed files differ
 * from what this would write.
 *
 * diffBar.ts is bundled on the fly (it is pure, no `vscode` import) because the extension build
 * produces a single bundle, not importable per-module output.
 */
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'diff-bar-'));
try {
  const outfile = join(scratch, 'diffBar.cjs');
  await build({ entryPoints: [join(root, 'src', 'views', 'diffBar.ts')], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' });
  const { allDiffBarShapes, diffBarIconPath, diffBarSvg } = createRequire(import.meta.url)(outfile);
  for (const theme of ['light', 'dark']) {
    for (const shape of allDiffBarShapes()) {
      const target = join(root, diffBarIconPath(shape, theme));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, diffBarSvg(shape, theme));
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
