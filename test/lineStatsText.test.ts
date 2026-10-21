import { describe, expect, it } from 'vitest';
import { fileLineStatsText, lineStatsTooltip, totalLineStatsText } from '../src/views/lineStatsText';

describe('fileLineStatsText', () => {
  it('shows +added −removed with a real minus sign', () => {
    expect(fileLineStatsText({ added: 12, deleted: 3, binary: false })).toBe('+12 −3');
  });

  it('says binary instead of +0 −0', () => {
    expect(fileLineStatsText({ added: 0, deleted: 0, binary: true })).toBe('binary');
  });

  it('is empty when counts are unknown', () => {
    expect(fileLineStatsText(undefined)).toBe('');
  });
});

describe('totalLineStatsText', () => {
  it('formats totals', () => {
    expect(totalLineStatsText({ added: 320, deleted: 0 })).toBe('+320 −0');
  });
});

describe('lineStatsTooltip', () => {
  it('pluralizes added lines', () => {
    expect(lineStatsTooltip({ added: 1, deleted: 4, binary: false })).toBe('1 line added, 4 removed');
    expect(lineStatsTooltip({ added: 2, deleted: 0, binary: false })).toBe('2 lines added, 0 removed');
  });

  it('describes binary files and is undefined when unknown', () => {
    expect(lineStatsTooltip({ added: 0, deleted: 0, binary: true })).toBe('Binary file');
    expect(lineStatsTooltip(undefined)).toBeUndefined();
  });
});
