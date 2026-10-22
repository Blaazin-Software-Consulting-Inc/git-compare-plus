import { describe, expect, it } from 'vitest';
import { SEARCH_KINDS, searchArgs, searchDescription } from '../src/commits/commitSearch';
import { olderFirst } from '../src/commits/commitTarget';
import { repo } from './helpers';

describe('searchArgs', () => {
  it('searches every branch and tag, case-insensitively and literally where git allows', () => {
    expect(searchArgs({ kind: 'message', text: ' fix (login) ' })).toEqual(['--all', '-i', '--fixed-strings', '--grep=fix (login)']);
    expect(searchArgs({ kind: 'author', text: 'ada' })).toEqual(['--all', '-i', '--fixed-strings', '--author=ada']);
    expect(searchArgs({ kind: 'code', text: 'parseThing(' })).toEqual(['--all', '-SparseThing(']);
  });

  it('matches the text anywhere in a file path, with glob characters taken literally', () => {
    expect(searchArgs({ kind: 'file', text: 'src/auth' })).toEqual(['--all', '--', ':(icase)*src/auth*']);
    expect(searchArgs({ kind: 'file', text: 'a*b' })).toEqual(['--all', '--', ':(icase)*a\\*b*']);
  });

  it('has no log arguments for a lookup by ID', () => {
    expect(searchArgs({ kind: 'id', text: 'abc' })).toBeUndefined();
  });

  it('offers every kind once, in a fixed order', () => {
    expect(SEARCH_KINDS.map((k) => k.kind)).toEqual(['message', 'author', 'file', 'code', 'id']);
  });
});

describe('searchDescription', () => {
  it('says what was searched and how many matched', () => {
    expect(searchDescription({ kind: 'message', text: 'login' }, 12, false)).toBe('message contains "login" · 12 commits');
    expect(searchDescription({ kind: 'code', text: 'x' }, 1, false)).toBe('added or removed "x" · 1 commit');
    expect(searchDescription({ kind: 'file', text: 'auth' }, 200, true)).toBe('changed a file matching "auth" · 200+ commits');
  });
});

describe('olderFirst', () => {
  const target = (sha: string, authoredAt: number) => ({ repo: repo('svc'), root: '/ws/svc', commit: { sha, parents: [], author: 'a', authoredAt, subject: sha } });

  it('puts the older commit first (the Against side)', () => {
    const [older, newer] = olderFirst(target('new', 2), target('old', 1));
    expect([older.commit.sha, newer.commit.sha]).toEqual(['old', 'new']);
  });

  it('orders same-time commits by ID so the result is stable', () => {
    expect(olderFirst(target('b', 1), target('a', 1)).map((t) => t.commit.sha)).toEqual(['a', 'b']);
  });
});
