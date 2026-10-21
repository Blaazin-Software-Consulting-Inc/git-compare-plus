import { describe, expect, it } from 'vitest';
import type { CommitEntry } from '../src/git/parsers';
import { commitCountText, commitDescription, commitTitle, commitTooltip } from '../src/views/commitText';

const HOUR = 3_600_000;
const commit = (parents: string[], subject = 'Fix the thing'): CommitEntry => ({
  sha: 'abcdef0123456789abcdef0123456789abcdef01',
  parents,
  author: 'Ada',
  authoredAt: Date.UTC(2026, 9, 21, 9, 30),
  subject,
});

describe('commitText', () => {
  it('counts, with + when truncated', () => {
    expect(commitCountText({ entries: [commit(['p'])], truncated: false })).toBe('1');
    expect(commitCountText({ entries: [commit(['p'])], truncated: true })).toBe('1+');
  });

  it('describes a commit with short SHA, author and age; merges say so', () => {
    const now = Date.UTC(2026, 9, 21, 12, 30);
    expect(commitDescription(commit(['p']), now)).toBe('abcdef0 · Ada · 3 h ago');
    expect(commitDescription(commit(['p1', 'p2']), now + 0 * HOUR)).toBe('abcdef0 · merge · Ada · 3 h ago');
  });

  it('explains in the tooltip what clicking does, per commit kind', () => {
    expect(commitTooltip(commit(['p']))).toContain('Click to open the files this commit changed.');
    expect(commitTooltip(commit(['p1', 'p2']))).toContain('compared with its first parent');
    expect(commitTooltip(commit([]))).toContain('no earlier version');
    expect(commitTooltip(commit(['p']))).toContain('2026-10-21 09:30 UTC');
  });

  it('titles diffs with short SHA and subject', () => {
    expect(commitTitle(commit(['p']))).toBe('abcdef0 Fix the thing');
  });
});
