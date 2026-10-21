import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allDiffBarShapes, diffBarIconPath, diffBarShape, diffBarSvg, lineStatsHoverHtml } from '../src/views/diffBar';

const lines = (added: number, deleted: number) => ({ added, deleted, binary: false });

describe('diffBarShape', () => {
  it('fills all five squares in proportion once five or more lines changed', () => {
    expect(diffBarShape(lines(30, 20))).toEqual({ added: 3, removed: 2 });
    expect(diffBarShape(lines(100, 0))).toEqual({ added: 5, removed: 0 });
    expect(diffBarShape(lines(0, 7))).toEqual({ added: 0, removed: 5 });
  });

  it('uses one square per line for small changes, leaving the rest grey', () => {
    expect(diffBarShape(lines(1, 0))).toEqual({ added: 1, removed: 0 });
    expect(diffBarShape(lines(1, 1))).toEqual({ added: 1, removed: 1 });
    expect(diffBarShape(lines(2, 1))).toEqual({ added: 2, removed: 1 });
  });

  it('always shows at least one square for a side that has lines', () => {
    expect(diffBarShape(lines(500, 1))).toEqual({ added: 4, removed: 1 });
    expect(diffBarShape(lines(1, 500))).toEqual({ added: 1, removed: 4 });
  });

  it('is all grey for a pure rename, and undefined for binary or unknown counts', () => {
    expect(diffBarShape(lines(0, 0))).toEqual({ added: 0, removed: 0 });
    expect(diffBarShape({ added: 0, deleted: 0, binary: true })).toBeUndefined();
    expect(diffBarShape(undefined)).toBeUndefined();
  });

  it('only ever returns a shape that has an icon file', () => {
    const known = new Set(allDiffBarShapes().map((s) => `${s.added}-${s.removed}`));
    for (let added = 0; added <= 40; added++) {
      for (let deleted = 0; deleted <= 40; deleted++) {
        const shape = diffBarShape(lines(added, deleted));
        expect(known.has(`${shape?.added}-${shape?.removed}`)).toBe(true);
      }
    }
  });
});

describe('icon files', () => {
  it('has 21 shapes', () => {
    expect(allDiffBarShapes()).toHaveLength(21);
  });

  it('match the generator exactly (run `npm run generate:icons` after changing diffBar.ts)', () => {
    const root = path.join(__dirname, '..');
    for (const theme of ['light', 'dark'] as const) {
      for (const shape of allDiffBarShapes()) {
        expect(readFileSync(path.join(root, diffBarIconPath(shape, theme)), 'utf8')).toBe(diffBarSvg(shape, theme));
      }
    }
  });

  it('draws green, then red, then grey squares in that order', () => {
    const fills = [...diffBarSvg({ added: 2, removed: 1 }, 'dark').matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    expect(fills).toEqual(['#3fb950', '#3fb950', '#f85149', '#484f58', '#484f58']);
  });
});

describe('lineStatsHoverHtml', () => {
  it('colours the counts and the squares with the span form the hover sanitiser keeps', () => {
    const html = lineStatsHoverHtml(lines(12, 3)) ?? '';
    expect(html).toContain('<span style="color:#2ea043;">+12</span>');
    expect(html).toContain('<span style="color:#da3633;">−3</span>');
    expect(html.match(/■/g)).toHaveLength(5);
  });

  it('says Binary file without colour, and is undefined when unknown', () => {
    expect(lineStatsHoverHtml({ added: 0, deleted: 0, binary: true })).toBe('Binary file');
    expect(lineStatsHoverHtml(undefined)).toBeUndefined();
  });
});
