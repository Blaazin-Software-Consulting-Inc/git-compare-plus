/**
 * lineStatsText — wording of +/− line counts in the Changes view (file rows, repo rows, view title).
 *
 * Pure (no `vscode` import) so the formatting is unit-tested directly. Uses U+2212 MINUS SIGN, not
 * a hyphen, so "+12 −3" lines up visually the way GitHub and the SCM view show it.
 */
import type { LineStats } from '../git/parsers';

/**
 * Short form for a file row: `+12 −3`, `binary`, or `''` when the counts are unknown (stats are
 * best-effort; an empty string keeps the row from claiming "+0 −0").
 */
export function fileLineStatsText(lines: LineStats | undefined): string {
  if (lines === undefined) {
    return '';
  }
  return lines.binary ? 'binary' : `+${lines.added} −${lines.deleted}`;
}

/** Totals for a repo row or the view title: `+320 −45`. */
export function totalLineStatsText(totals: { readonly added: number; readonly deleted: number }): string {
  return `+${totals.added} −${totals.deleted}`;
}

/** Tooltip sentence for a file: `12 lines added, 3 removed`, `Binary file`, or `undefined`. */
export function lineStatsTooltip(lines: LineStats | undefined): string | undefined {
  if (lines === undefined) {
    return undefined;
  }
  if (lines.binary) {
    return 'Binary file';
  }
  return `${lines.added} line${lines.added === 1 ? '' : 's'} added, ${lines.deleted} removed`;
}
