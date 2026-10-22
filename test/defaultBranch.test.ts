import { describe, expect, it } from 'vitest';
import { DEFAULT_BRANCH_SETTINGS, fallbackCandidates, overrideFor, parseDefaultBranchSettings } from '../src/defaultBranch';

describe('overrideFor', () => {
  const settings = (overrides: Record<string, string>) => ({ remote: 'origin', overrides });

  it('matches by folder name', () => {
    expect(overrideFor(settings({ api: 'upstream/develop' }), '/work/api')).toBe('upstream/develop');
    expect(overrideFor(settings({ api: 'upstream/develop' }), '/work/web')).toBeUndefined();
  });

  it('prefers an absolute-path key over a folder-name key, ignoring a trailing slash', () => {
    const both = settings({ api: 'by-name', '/other/api/': 'by-path' });
    expect(overrideFor(both, '/other/api')).toBe('by-path');
    expect(overrideFor(both, '/work/api')).toBe('by-name');
  });

  it('ignores blank values', () => {
    expect(overrideFor(settings({ api: '  ' }), '/work/api')).toBeUndefined();
  });
});

describe('fallbackCandidates', () => {
  it('uses the configured remote', () => {
    expect(fallbackCandidates('upstream')).toEqual(['upstream/main', 'upstream/master', 'main', 'master']);
  });
});

describe('parseDefaultBranchSettings', () => {
  it('trims and keeps valid values', () => {
    expect(parseDefaultBranchSettings(' upstream ', { api: ' upstream/main ' })).toEqual({ remote: 'upstream', overrides: { api: 'upstream/main' } });
  });

  it('falls back to origin and drops non-string overrides', () => {
    expect(parseDefaultBranchSettings('', { api: 3, web: 'main' })).toEqual({ remote: 'origin', overrides: { web: 'main' } });
    expect(parseDefaultBranchSettings(undefined, 'junk')).toEqual(DEFAULT_BRANCH_SETTINGS);
  });
});
