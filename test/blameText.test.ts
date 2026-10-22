import { describe, expect, it } from 'vitest';
import { BLAME_COMMANDS, blameAnnotation, blameHoverMarkdown, blameStatusText, blameTarget, escapeMarkdown } from '../src/blame/blameText';
import type { BlameLine } from '../src/git/parsers';

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const line = (overrides: Partial<BlameLine['commit']> = {}): BlameLine => ({
  path: 'src/a.ts',
  originalLine: 3,
  commit: { sha: 'abcdef0123456789abcdef0123456789abcdef01', author: 'Ada Lovelace', authoredAt: NOW - 3 * DAY, summary: 'Fix login retry', uncommitted: false, ...overrides },
});

describe('blameAnnotation / blameStatusText', () => {
  it('shows author, age and subject', () => {
    expect(blameAnnotation(line(), NOW)).toBe('Ada Lovelace, 3 days ago · Fix login retry');
    expect(blameStatusText(line(), NOW)).toBe('Ada Lovelace, 3 days ago');
  });

  it('shortens long subjects with an ellipsis', () => {
    const text = blameAnnotation(line({ summary: 'x'.repeat(100) }), NOW);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(100);
  });

  it('says uncommitted for lines not in any commit', () => {
    expect(blameAnnotation(line({ uncommitted: true }), NOW)).toBe('Uncommitted change');
    expect(blameStatusText(line({ uncommitted: true }), NOW)).toBe('Uncommitted');
  });
});

describe('blameHoverMarkdown', () => {
  const previous = { sha: 'b'.repeat(40), path: 'src/old.ts' };

  it('has the message, short SHA and the three actions with their target', () => {
    const blamed = line({ previous });
    const md = blameHoverMarkdown(blamed, blameTarget('/repo', 'src/a.ts', blamed), 'Fix login retry\n\nBody line', NOW);
    expect(md).toContain('**Ada Lovelace**, 3 days ago (2026-10-19 12:00 UTC)');
    expect(md).toContain('Body line');
    expect(md).toContain('`abcdef0`');
    for (const command of Object.values(BLAME_COMMANDS)) {
      expect(md).toContain(`command:${command}?`);
    }
    const args = JSON.parse(decodeURIComponent(md.split(`command:${BLAME_COMMANDS.compareWithPrevious}?`)[1]?.split(' ')[0] ?? ''));
    expect(args).toEqual([{ root: '/repo', path: 'src/a.ts', sha: blamed.commit.sha, pathAtCommit: 'src/a.ts', previous }]);
  });

  it('leaves out Compare with Previous when the commit added the file', () => {
    const blamed = line();
    expect(blameHoverMarkdown(blamed, blameTarget('/repo', 'src/a.ts', blamed), undefined, NOW)).not.toContain(BLAME_COMMANDS.compareWithPrevious);
  });

  it('escapes author names and messages so they cannot add links, icons or formatting', () => {
    const blamed = line({ author: '*Eve* [x](command:evil)', summary: '$(alert) <b>hi</b>' });
    const md = blameHoverMarkdown(blamed, blameTarget('/repo', 'src/a.ts', blamed), undefined, NOW);
    expect(md).toContain('\\*Eve\\* \\[x\\]\\(command:evil\\)');
    expect(md).toContain('\\$\\(alert\\) \\<b\\>hi\\</b\\>');
    expect(md).not.toContain('](command:evil)');
  });

  it('explains uncommitted lines without actions', () => {
    const blamed = line({ uncommitted: true });
    const md = blameHoverMarkdown(blamed, blameTarget('/repo', 'src/a.ts', blamed), undefined, NOW);
    expect(md).toContain('Uncommitted change');
    expect(md).not.toContain('command:');
  });

  it('escapeMarkdown leaves plain text alone', () => {
    expect(escapeMarkdown('Fix login')).toBe('Fix login');
  });
});
