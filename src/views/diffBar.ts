/**
 * diffBar — the small green/red "diff bar" that stands in for the file-type icon on each row of
 * the Changes view, plus the coloured line counts in the row's hover.
 *
 * Why an icon: a tree row's description is plain text that the editor always draws in its dim
 * colour (the API takes a string), so `+12 −3` cannot be green and red there. The icon and the
 * hover are the only places on a row that can carry colour.
 *
 * The bar is five squares, GitHub style: green for added lines, red for removed, grey for unused
 * squares when the change is small (fewer than five lines). Icons are static SVG files under
 * `media/diff-bar/<light|dark>/<added>-<removed>.svg`, one per possible bar (21 shapes), generated
 * from this module by `npm run generate:icons` and checked against it in test/diffBar.test.ts, so
 * they cannot drift. Static files instead of writing icons at runtime: nothing is written to disk
 * by the extension, and they ship inside the .vsix.
 *
 * Pure (no `vscode` import).
 */
import type { LineStats } from '../git/parsers';

/** Squares in a bar. */
export const DIFF_BAR_BLOCKS = 5;

/** How many of the five squares are green and red; the rest are grey. */
export interface DiffBarShape {
  readonly added: number;
  readonly removed: number;
}

/** Colour theme an icon file is drawn for (the tree picks light or dark automatically). */
export type IconTheme = 'light' | 'dark';

// GitHub's diffstat palette: the light-theme colours on white, the dark-theme ones on near-black.
const BLOCK_COLORS: Record<IconTheme, { added: string; removed: string; neutral: string }> = {
  light: { added: '#2da44e', removed: '#cf222e', neutral: '#d0d7de' },
  dark: { added: '#3fb950', removed: '#f85149', neutral: '#484f58' },
};

// Hover text is drawn on the hover widget's background, which follows the theme, but the hover
// cannot know which theme is active; these mid-tones read on both light and dark backgrounds.
const HOVER_COLORS = { added: '#2ea043', removed: '#da3633', neutral: '#8b949e' };

/**
 * The bar for a file, or `undefined` when there is nothing meaningful to draw (counts unknown, or
 * a binary file); the row then keeps its normal file-type icon.
 *
 * Squares used = min(5, total lines changed), so a one-line fix shows one coloured square and four
 * grey ones, while anything of five lines or more fills the bar. The used squares are split in
 * proportion to added vs removed, but a side with any lines always gets at least one square, so a
 * 1-line deletion in a 500-line addition is still visible.
 */
export function diffBarShape(lines: LineStats | undefined): DiffBarShape | undefined {
  if (lines === undefined || lines.binary) {
    return undefined;
  }
  const total = lines.added + lines.deleted;
  if (total === 0) {
    // Pure rename or mode change: no lines moved, so an all-grey bar.
    return { added: 0, removed: 0 };
  }
  const used = Math.min(DIFF_BAR_BLOCKS, total);
  let added = Math.round((used * lines.added) / total);
  if (lines.added > 0 && added === 0) {
    added = 1;
  }
  if (lines.deleted > 0 && added === used) {
    added = used - 1;
  }
  return { added, removed: used - added };
}

/** Every bar that `diffBarShape` can return: green + red ≤ 5 (21 shapes). */
export function allDiffBarShapes(): DiffBarShape[] {
  const shapes: DiffBarShape[] = [];
  for (let added = 0; added <= DIFF_BAR_BLOCKS; added++) {
    for (let removed = 0; added + removed <= DIFF_BAR_BLOCKS; removed++) {
      shapes.push({ added, removed });
    }
  }
  return shapes;
}

/** Icon path relative to the extension root, e.g. `media/diff-bar/dark/3-2.svg`. */
export function diffBarIconPath(shape: DiffBarShape, theme: IconTheme): string {
  return `media/diff-bar/${theme}/${shape.added}-${shape.removed}.svg`;
}

/**
 * SVG for a bar: five rounded squares across a 16×16 tree icon, vertically centred. Colours are
 * fixed per theme because an icon file cannot read theme colours.
 */
export function diffBarSvg(shape: DiffBarShape, theme: IconTheme): string {
  const colors = BLOCK_COLORS[theme];
  // 5 squares of 2.4 + 4 gaps of 1 = 16, the full icon width; 7 tall keeps them square-ish but
  // reads as a bar at tree-icon size.
  const size = 2.4;
  const gap = 1;
  const rects = Array.from({ length: DIFF_BAR_BLOCKS }, (_, i) => {
    const fill = i < shape.added ? colors.added : i < shape.added + shape.removed ? colors.removed : colors.neutral;
    const x = Number((i * (size + gap)).toFixed(1));
    return `<rect x="${x}" y="4.5" width="${size}" height="7" rx="0.6" fill="${fill}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${rects.join('')}</svg>\n`;
}

/**
 * Hover HTML for the counts: green `+12`, red `−3`, and the same bar as small coloured squares.
 * Uses only `<span style="color:#rrggbb;">`, the form the editor's hover sanitiser keeps.
 * @returns undefined when counts are unknown; `Binary file` (no colour) for binary files.
 */
export function lineStatsHoverHtml(lines: LineStats | undefined): string | undefined {
  if (lines === undefined) {
    return undefined;
  }
  if (lines.binary) {
    return 'Binary file';
  }
  const shape = diffBarShape(lines) ?? { added: 0, removed: 0 };
  const squares = Array.from({ length: DIFF_BAR_BLOCKS }, (_, i) =>
    i < shape.added ? HOVER_COLORS.added : i < shape.added + shape.removed ? HOVER_COLORS.removed : HOVER_COLORS.neutral,
  )
    .map((color) => `<span style="color:${color};">■</span>`)
    .join('');
  return (
    `<span style="color:${HOVER_COLORS.added};">+${lines.added}</span> ` +
    `<span style="color:${HOVER_COLORS.removed};">−${lines.deleted}</span> ${squares}`
  );
}
