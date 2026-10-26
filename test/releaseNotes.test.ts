import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs build script with JSDoc types, no declaration file.
import { checkTag, releaseNotes } from '../scripts/release-notes.mjs';

const CHANGELOG = `# Changelog

Intro.

## 1.1.0 (unreleased)

- Next thing.

## 1.0.0 (2026-10-26)

First public release.

### Comparing

- Two named sides.

## 0.9.0

- Internal.
`;

describe('checkTag', () => {
  it('accepts v<version>', () => {
    expect(() => checkTag('v1.0.0', '1.0.0')).not.toThrow();
  });

  it.each([
    ['1.0.0', 'no v prefix'],
    ['v1.0.1', 'another version'],
    ['v1.0.0-rc1', 'a suffix'],
    ['release-1.0.0', 'another prefix'],
  ])('refuses %s (%s)', (tag) => {
    expect(() => checkTag(tag, '1.0.0')).toThrow(/expected v1\.0\.0/);
  });
});

describe('releaseNotes', () => {
  it('returns the date and the entry up to the next version, keeping its ### sections', () => {
    expect(releaseNotes(CHANGELOG, '1.0.0')).toEqual({
      date: '2026-10-26',
      notes: 'First public release.\n\n### Comparing\n\n- Two named sides.',
    });
  });

  it('reads the last entry to the end of the file', () => {
    const changelog = '## 2.0.0 (2027-01-02)\n\n- Only entry.\n';
    expect(releaseNotes(changelog, '2.0.0').notes).toBe('- Only entry.');
  });

  it('handles Windows line endings', () => {
    expect(releaseNotes('## 1.0.0 (2026-10-26)\r\n\r\n- A.\r\n', '1.0.0').notes).toBe('- A.');
  });

  it('refuses an entry that is still unreleased', () => {
    expect(() => releaseNotes(CHANGELOG, '1.1.0')).toThrow(/no release date/);
  });

  it('refuses an undated entry', () => {
    expect(() => releaseNotes(CHANGELOG, '0.9.0')).toThrow(/no release date/);
  });

  it('refuses a missing version, without matching a longer one that starts the same', () => {
    expect(() => releaseNotes(CHANGELOG, '1.0')).toThrow(/no "## 1\.0" entry/);
    expect(() => releaseNotes(CHANGELOG, '2.0.0')).toThrow(/no "## 2\.0\.0" entry/);
  });

  it('refuses an empty entry', () => {
    expect(() => releaseNotes('## 1.0.0 (2026-10-26)\n\n## 0.9.0\n', '1.0.0')).toThrow(/empty/);
  });
});
