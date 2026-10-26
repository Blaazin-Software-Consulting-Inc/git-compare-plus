import { homedir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayPath, isOneOf, samePath } from '../src/paths';

describe('paths', () => {
  it('treats a trailing slash and repeated separators as the same folder', () => {
    expect(samePath('/a/b/', '/a/b')).toBe(true);
    expect(samePath('/a/b', '/a/c')).toBe(false);
    expect(isOneOf('/a/b', ['/x', '/a/b/'])).toBe(true);
    expect(isOneOf('/a/b', [])).toBe(false);
  });

  it('shows paths inside the repo relative to it, with forward slashes on every platform', () => {
    expect(displayPath('/r', '/r/.claude/worktrees/x')).toBe('.claude/worktrees/x');
    expect(displayPath('/r', path.join('/r', '.claude', 'worktrees', 'x'))).toBe('.claude/worktrees/x');
  });

  it('shows other paths with ~ for home, however the home folder is spelled', () => {
    expect(displayPath('/r', path.join(homedir(), 'elsewhere', 'wt'))).toBe('~/elsewhere/wt');
    expect(displayPath('/r', `${homedir().split(path.sep).join('/')}/elsewhere/wt`)).toBe('~/elsewhere/wt');
  });

  it('does not treat a sibling folder that starts with the home name as home', () => {
    const sibling = `${homedir().split(path.sep).join('/')}2/wt`;
    expect(displayPath('/r', sibling)).toBe(sibling);
  });
});
