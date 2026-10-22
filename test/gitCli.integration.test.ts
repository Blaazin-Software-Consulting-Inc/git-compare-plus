/**
 * End-to-end check against real git: builds a throwaway repo with a branch, a linked worktree,
 * commits on both sides, uncommitted edits and an untracked file, then runs GitCli + runComparisons
 * exactly as the extension does. Catches format drift that the parser unit tests cannot.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runComparisons, type BaseSpec, type Subject } from '../src/comparison';
import { GitCli } from '../src/git/gitCli';
import { recordingLogger } from './helpers';

let sandbox: string;
let repoRoot: string;
let worktreeRoot: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

beforeAll(() => {
  // realpath: macOS tmpdir is a symlink (/var → /private/var) and git reports resolved paths.
  sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'branch-compare-')));
  repoRoot = path.join(sandbox, 'repo');
  worktreeRoot = path.join(sandbox, 'wt');
  git(sandbox, 'init', '-q', '-b', 'main', repoRoot);
  writeFileSync(path.join(repoRoot, 'keep.txt'), 'keep\n');
  writeFileSync(path.join(repoRoot, 'edit.txt'), 'v1\n');
  writeFileSync(path.join(repoRoot, 'old-name.txt'), 'rename me\nline2\nline3\n');
  writeFileSync(path.join(repoRoot, 'remove.txt'), 'bye\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-q', '-m', 'base');

  git(repoRoot, 'worktree', 'add', '-q', '-b', 'feature', worktreeRoot);
  git(worktreeRoot, 'mv', 'old-name.txt', 'new-name.txt');
  git(worktreeRoot, 'rm', '-q', 'remove.txt');
  git(worktreeRoot, 'commit', '-q', '-m', 'feature work');
  writeFileSync(path.join(worktreeRoot, 'edit.txt'), 'v2 uncommitted\n');
  writeFileSync(path.join(worktreeRoot, 'brand-new.txt'), 'untracked\n');

  // A commit on main AFTER the branch point must not appear in the comparison (three-dot semantics).
  writeFileSync(path.join(repoRoot, 'main-only.txt'), 'later\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-q', '-m', 'main moves on');
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('GitCli against a real repository', () => {
  it('lists the main worktree first, then the linked one', async () => {
    const cli = new GitCli('git', recordingLogger());
    const worktrees = await cli.worktrees(worktreeRoot);
    expect(worktrees.map((w) => [w.path, w.branch])).toEqual([
      [repoRoot, 'main'],
      [worktreeRoot, 'feature'],
    ]);
    expect(await cli.commonDir(worktreeRoot)).toBe(await cli.commonDir(repoRoot));
  });

  it('compares the worktree with main: commits + uncommitted + untracked, nothing from later main', async () => {
    const cli = new GitCli('git', recordingLogger());
    const [result] = await runComparisons(
      cli,
      [{ repo: { name: 'repo', root: repoRoot, commonDir: '' }, subject: { kind: 'worktree', root: worktreeRoot, label: 'feature', includeUncommitted: true } }],
      { kind: 'ref', ref: 'main' },
      'merge-base',
      { includeUntracked: true, logger: recordingLogger() },
    );
    expect(result?.outcome).toBe('compared');
    expect(result?.files.map((f) => [f.status, f.path, f.oldPath])).toEqual([
      ['untracked', 'brand-new.txt', 'brand-new.txt'],
      ['modified', 'edit.txt', 'edit.txt'],
      ['renamed', 'new-name.txt', 'old-name.txt'],
      ['deleted', 'remove.txt', 'remove.txt'],
    ]);
    // Line counts: untracked from disk, the rest from `git diff --numstat` of the same sides.
    expect(result?.files.map((f) => [f.path, f.lines])).toEqual([
      ['brand-new.txt', { added: 1, deleted: 0, binary: false }],
      ['edit.txt', { added: 1, deleted: 1, binary: false }],
      ['new-name.txt', { added: 0, deleted: 0, binary: false }],
      ['remove.txt', { added: 0, deleted: 1, binary: false }],
    ]);
  });

  it('hashes files on disk exactly as git hash-object does; skips directories and missing files', async () => {
    const cli = new GitCli('git', recordingLogger());
    writeFileSync(path.join(worktreeRoot, 'hash-me.txt'), 'some content\n');
    // Creating symlinks on Windows needs Developer Mode or admin rights, which CI runners lack.
    const withSymlink = process.platform !== 'win32';
    if (withSymlink) {
      symlinkSync('hash-me.txt', path.join(worktreeRoot, 'link'));
    }
    mkdirSync(path.join(worktreeRoot, 'a-dir'));
    const hashes = await cli.hashWorkingFiles(worktreeRoot, ['hash-me.txt', 'link', 'a-dir', 'missing.txt']);
    // --no-filters: the hash of the bytes on disk, which is what hashWorkingFiles computes (a
    // Windows runner's core.autocrlf would otherwise change git's answer).
    expect(hashes.get('hash-me.txt')).toBe(git(worktreeRoot, 'hash-object', '--no-filters', 'hash-me.txt').trim());
    if (withSymlink) {
      // A symlink's blob is its target path, as git stores it.
      expect(hashes.get('link')).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: 'hash-me.txt', encoding: 'utf8' }).trim());
      rmSync(path.join(worktreeRoot, 'link'));
    }
    expect([...hashes.keys()].sort()).toEqual(withSymlink ? ['hash-me.txt', 'link'] : ['hash-me.txt']);
    rmSync(path.join(worktreeRoot, 'hash-me.txt'));
    rmSync(path.join(worktreeRoot, 'a-dir'), { recursive: true });
  });

  it('fingerprints survive committing a file unchanged, and change when it is edited', async () => {
    const subject = (includeUncommitted: boolean): Subject => ({ kind: 'worktree', root: worktreeRoot, label: 'feature', includeUncommitted });
    writeFileSync(path.join(worktreeRoot, 'reviewed.txt'), 'looked at this\n');
    const [onDisk] = await compare(subject(true), { kind: 'ref', ref: 'main' });
    const before = onDisk?.files.find((f) => f.path === 'reviewed.txt')?.fingerprint;
    expect(before).toMatch(/^->[0-9a-f]{40}$/);

    git(worktreeRoot, 'add', 'reviewed.txt');
    git(worktreeRoot, 'commit', '-q', '-m', 'commit what was reviewed');
    const [committed] = await compare(subject(false), { kind: 'ref', ref: 'main' });
    expect(committed?.files.find((f) => f.path === 'reviewed.txt')?.fingerprint).toBe(before);

    writeFileSync(path.join(worktreeRoot, 'reviewed.txt'), 'looked at this\nthen edited\n');
    const [edited] = await compare(subject(true), { kind: 'ref', ref: 'main' });
    expect(edited?.files.find((f) => f.path === 'reviewed.txt')?.fingerprint).not.toBe(before);
    // Modified files carry both sides.
    expect(edited?.files.find((f) => f.path === 'edit.txt')?.fingerprint).toMatch(/^[0-9a-f]{40}>[0-9a-f]{40}$/);

    git(worktreeRoot, 'checkout', '--', 'reviewed.txt');
    git(worktreeRoot, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(path.join(worktreeRoot, 'edit.txt'), 'v2 uncommitted\n');
    writeFileSync(path.join(worktreeRoot, 'brand-new.txt'), 'untracked\n');
  });

  it('reports binary files as binary, not as line counts', async () => {
    writeFileSync(path.join(worktreeRoot, 'blob.bin'), Buffer.from([0, 1, 2, 0, 10]));
    const [result] = await compare({ kind: 'worktree', root: worktreeRoot, label: 'feature', includeUncommitted: true }, { kind: 'ref', ref: 'main' });
    expect(result?.files.find((f) => f.path === 'blob.bin')?.lines).toEqual({ added: 0, deleted: 0, binary: true });
    git(worktreeRoot, 'add', 'blob.bin');
    const [staged] = await compare({ kind: 'worktree', root: worktreeRoot, label: 'feature', includeUncommitted: true }, { kind: 'ref', ref: 'main' });
    expect(staged?.files.find((f) => f.path === 'blob.bin')).toMatchObject({ status: 'added', lines: { binary: true } });
    git(worktreeRoot, 'rm', '-q', '--cached', 'blob.bin');
    rmSync(path.join(worktreeRoot, 'blob.bin'));
  });

  it('compares the branch (committed only) from the main worktree', async () => {
    const cli = new GitCli('git', recordingLogger());
    const [result] = await runComparisons(
      cli,
      [{ repo: { name: 'repo', root: repoRoot, commonDir: '' }, subject: { kind: 'ref', ref: 'feature', label: 'feature' } }],
      { kind: 'ref', ref: 'main' },
      'merge-base',
      { includeUntracked: true, logger: recordingLogger() },
    );
    expect(result?.files.map((f) => f.path)).toEqual(['new-name.txt', 'remove.txt']);
  });

  it('reads historical content and reports a missing ref as ref_missing', async () => {
    const cli = new GitCli('git', recordingLogger());
    const mergeBase = await cli.mergeBase(worktreeRoot, 'main', 'HEAD');
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(await cli.show(worktreeRoot, mergeBase ?? '', 'old-name.txt')).toBe('rename me\nline2\nline3\n');
    expect(await cli.mergeBase(repoRoot, 'does-not-exist', 'HEAD')).toBeUndefined();
  });

  it('uses the configured remote and per-repo overrides for the default branch', async () => {
    const upstream = path.join(sandbox, 'upstream.git');
    git(sandbox, 'init', '-q', '--bare', '-b', 'main', upstream);
    git(repoRoot, 'remote', 'add', 'upstream', upstream);
    git(repoRoot, 'push', '-q', 'upstream', 'main:develop');
    git(repoRoot, 'fetch', '-q', 'upstream');
    git(repoRoot, 'remote', 'set-head', 'upstream', 'develop');
    try {
      const withRemote = new GitCli('git', recordingLogger(), () => ({ remote: 'upstream', overrides: {} }));
      expect(await withRemote.defaultBranch(worktreeRoot)).toBe('upstream/develop');

      // Keyed by the main worktree's folder name, and applied from a linked worktree too.
      const withOverride = new GitCli('git', recordingLogger(), () => ({ remote: 'upstream', overrides: { repo: 'feature' } }));
      expect(await withOverride.defaultBranch(worktreeRoot)).toBe('feature');

      const logger = recordingLogger();
      const withTypo = new GitCli('git', logger, () => ({ remote: 'upstream', overrides: { repo: 'no-such-branch' } }));
      expect(await withTypo.defaultBranch(repoRoot)).toBe('upstream/develop');
      expect(logger.calls.warn).toEqual([[expect.stringContaining('override does not exist'), expect.objectContaining({ override: 'no-such-branch' })]]);
    } finally {
      git(repoRoot, 'remote', 'remove', 'upstream');
    }
  });

  it('falls back to a local main when origin/HEAD is not set', async () => {
    const logger = recordingLogger();
    expect(await new GitCli('git', logger).defaultBranch(repoRoot)).toBe('main');
    expect(logger.calls.warn).toHaveLength(1);
  });

  it('committed-only worktree: excludes uncommitted edits and counts them', async () => {
    const [result] = await compare({ kind: 'worktree', root: worktreeRoot, label: 'feature', includeUncommitted: false }, { kind: 'ref', ref: 'main' });
    expect(result?.files.map((f) => f.path)).toEqual(['new-name.txt', 'remove.txt']);
    // edit.txt (modified) + brand-new.txt (untracked)
    expect(result?.excludedUncommitted.subject).toBe(2);
  });

  it('direct mode includes the later main commit as a difference', async () => {
    const [result] = await compare({ kind: 'ref', ref: 'feature', label: 'feature' }, { kind: 'ref', ref: 'main' }, 'direct');
    expect(result?.files.map((f) => [f.status, f.path])).toContainEqual(['deleted', 'main-only.txt']);
  });

  it('base = another worktree INCLUDING its uncommitted edits, without touching that worktree', async () => {
    const indexPath = path.join(repoRoot, '.git', 'index');
    const indexBefore = readFileSync(indexPath);
    const statusBefore = git(repoRoot, 'status', '--porcelain');
    writeFileSync(path.join(repoRoot, 'keep.txt'), 'keep\nedited in main worktree\n');

    // Subject: the feature worktree's branch tip. Base: the MAIN worktree as it is on disk.
    const base: BaseSpec = { kind: 'worktree', root: repoRoot, label: 'main', includeUncommitted: true };
    const [result] = await compare({ kind: 'ref', ref: 'feature', label: 'feature' }, base);

    expect(result?.mode).toBe('direct');
    expect(result?.baseRevision).toMatch(/^[0-9a-f]{40}$/);
    // keep.txt differs only because of the uncommitted edit in the base worktree.
    expect(result?.files.map((f) => f.path)).toContain('keep.txt');
    const cli = new GitCli('git', recordingLogger());
    expect(await cli.show(repoRoot, result?.baseRevision ?? '', 'keep.txt')).toBe('keep\nedited in main worktree\n');

    // The base worktree's real index is untouched; only the edit we made shows in its status.
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(git(repoRoot, 'status', '--porcelain')).toBe(`${statusBefore} M keep.txt\n`);
    git(repoRoot, 'checkout', '--', 'keep.txt');
  });

  it('base = another worktree, committed only: reports its uncommitted file count', async () => {
    writeFileSync(path.join(repoRoot, 'keep.txt'), 'dirty\n');
    const base: BaseSpec = { kind: 'worktree', root: repoRoot, label: 'main', includeUncommitted: false };
    const [result] = await compare({ kind: 'ref', ref: 'feature', label: 'feature' }, base);
    expect(result?.excludedUncommitted.base).toBe(1);
    expect(result?.files.map((f) => f.path)).not.toContain('keep.txt');
    git(repoRoot, 'checkout', '--', 'keep.txt');
  });

  it('lists only the commits since the branch point, newest first', async () => {
    const [result] = await compare({ kind: 'ref', ref: 'feature', label: 'feature' }, { kind: 'ref', ref: 'main' });
    expect(result?.commits?.entries.map((c) => c.subject)).toEqual(['feature work']);
    expect(result?.commits?.entries[0]).toMatchObject({ author: 't', parents: [expect.stringMatching(/^[0-9a-f]{40}$/)] });
    expect(result?.commits?.truncated).toBe(false);
  });

  it('lists tags newest first and recent commits across all branches', async () => {
    git(repoRoot, 'tag', 'v0.1', 'main~1');
    git(repoRoot, 'tag', '-a', '-m', 'release', 'v0.2', 'main');
    try {
      const cli = new GitCli('git', recordingLogger());
      const tags = await cli.tags(repoRoot);
      expect(tags.map((t) => t.name).sort()).toEqual(['v0.1', 'v0.2']);
      expect(tags.every((t) => typeof t.createdAt === 'number')).toBe(true);
      // --all: commits on feature are listed too, not only those on main.
      const subjects = (await cli.recentCommits(repoRoot, 50)).map((c) => c.subject);
      expect(subjects).toEqual(expect.arrayContaining(['feature work', 'main moves on', 'base']));
      expect(await cli.recentCommits(repoRoot, 1)).toHaveLength(1);
    } finally {
      git(repoRoot, 'tag', '-d', 'v0.1', 'v0.2');
    }
  });

  it('counts ahead/behind the same way in one walk and per revision', async () => {
    const cli = new GitCli('git', recordingLogger());
    const mainSha = (await cli.resolveCommit(repoRoot, 'main')) ?? '';
    const all = await cli.aheadBehindAllRefs(repoRoot, mainSha);
    // feature: 1 own commit; main moved on by 1 after the branch point.
    expect(all?.get('feature')).toEqual({ ahead: 1, behind: 1 });
    expect(all?.get('main')).toEqual({ ahead: 0, behind: 0 });
    expect(await cli.aheadBehind(repoRoot, mainSha, 'feature')).toEqual({ ahead: 1, behind: 1 });
  });

  it('reads commit dates for refs and worktree HEADs', async () => {
    const cli = new GitCli('git', recordingLogger());
    const refs = await cli.refs(repoRoot);
    expect(refs.find((r) => r.name === 'feature')?.committedAt).toBeGreaterThan(Date.now() - 3_600_000);
    const head = git(worktreeRoot, 'rev-parse', 'HEAD').trim();
    const dates = await cli.commitDates(repoRoot, [head, head]);
    expect([...dates.keys()]).toEqual([head]);
    expect(await cli.commitDates(repoRoot, [])).toEqual(new Map());
  });
});

function compare(subject: Subject, base: BaseSpec, mode: 'merge-base' | 'direct' = 'merge-base') {
  return runComparisons(
    new GitCli('git', recordingLogger()),
    [{ repo: { name: 'repo', root: repoRoot, commonDir: '' }, subject }],
    base,
    mode,
    { includeUntracked: true, logger: recordingLogger() },
  );
}
