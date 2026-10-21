/**
 * Writes media/diff-bar/<light|dark>/<added>-<removed>.svg from the compiled src/views/diffBar.ts.
 * Run with `npm run generate:icons` (builds first). test/diffBar.test.ts fails if the committed
 * files differ from what this would write.
 */
const fs = require('node:fs');
const path = require('node:path');
const { allDiffBarShapes, diffBarIconPath, diffBarSvg } = require('../dist/views/diffBar');

const root = path.join(__dirname, '..');
for (const theme of ['light', 'dark']) {
  for (const shape of allDiffBarShapes()) {
    const target = path.join(root, diffBarIconPath(shape, theme));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, diffBarSvg(shape, theme));
  }
}
