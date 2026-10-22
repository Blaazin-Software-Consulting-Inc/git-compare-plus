import { describe, expect, it } from 'vitest';
import { displayPath, isOneOf, samePath } from '../src/paths';

describe('paths', () => {
  it('treats a trailing slash and repeated separators as the same folder', () => {
    expect(samePath('/a/b/', '/a/b')).toBe(true);
    expect(samePath('/a/b', '/a/c')).toBe(false);
    expect(isOneOf('/a/b', ['/x', '/a/b/'])).toBe(true);
    expect(isOneOf('/a/b', [])).toBe(false);
  });

  it('shows paths inside the repo relative to it', () => {
    expect(displayPath('/r', '/r/.claude/worktrees/x')).toBe('.claude/worktrees/x');
  });

  it('shows other paths with ~ for home', () => {
    const home = process.env.HOME ?? '/home/u';
    process.env.HOME = home;
    expect(displayPath('/r', `${home}/elsewhere/wt`)).toBe('~/elsewhere/wt');
  });
});
