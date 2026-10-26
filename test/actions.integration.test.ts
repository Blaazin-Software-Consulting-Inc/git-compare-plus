/**
 * Real-git checks for the Repositories actions: fetch from a local "remote" (a bare repo in the
 * sandbox, so no network), worktree create/remove, branch create/delete, switch, and the safety
 * checks that gate the destructive ones.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitCli, redactUrlCredentials, summarizeStderr } from '../src/git/gitCli';
import { checkBranchDeletion, checkWorktreeRemoval, localNameForRemote, switchBlockers } from '../src/operations';
import { gitStylePath, recordingLogger } from './helpers';

let sandbox: string;
let remote: string;
let clone: string;
let other: string;
const cli = () => new GitCli('git', recordingLogger());

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

beforeAll(() => {
  sandbox = gitStylePath(mkdtempSync(path.join(tmpdir(), 'git-compare-plus-actions-')));
  remote = path.posix.join(sandbox, 'remote.git');
  clone = path.posix.join(sandbox, 'clone');
  other = path.posix.join(sandbox, 'other');
  git(sandbox, 'init', '-q', '--bare', '-b', 'master', remote);
  git(sandbox, 'clone', '-q', remote, other);
  commit(other, 'a.txt', 'a\n', 'first');
  git(other, 'push', '-q', 'origin', 'master');
  git(other, 'switch', '-q', '-c', 'feature/remote-only');
  commit(other, 'b.txt', 'b\n', 'feature');
  git(other, 'push', '-q', 'origin', 'feature/remote-only');
  git(sandbox, 'clone', '-q', remote, clone);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('fetch', () => {
  it('fetches new remote commits and records the fetch time', async () => {
    git(other, 'switch', '-q', 'master');
    commit(other, 'c.txt', 'c\n', 'later on master');
    git(other, 'push', '-q', 'origin', 'master');
    const before = git(clone, 'rev-parse', 'origin/master').trim();

    await cli().fetch(clone);

    expect(git(clone, 'rev-parse', 'origin/master').trim()).not.toBe(before);
    expect(await cli().lastFetchedAt(clone)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('logs the fetch at INFO and fails cleanly (redacted) for an unreachable remote', async () => {
    const logger = recordingLogger();
    const broken = path.join(sandbox, 'broken');
    git(sandbox, 'init', '-q', broken);
    git(broken, 'remote', 'add', 'origin', 'https://user:s3cret@127.0.0.1:9/nope.git');
    await expect(new GitCli('git', logger).fetch(broken)).rejects.toThrow(/git fetch failed/);
    expect(logger.calls.info.map(([m]) => m)).toContain('external request');
    const [, error] = logger.calls.error[0] ?? [];
    expect(JSON.stringify((error as { details?: unknown }).details)).not.toContain('s3cret');
  });
});

describe('worktrees', () => {
  it('creates a worktree with a new local branch tracking a remote branch', async () => {
    const target = path.join(sandbox, 'clone.worktrees', 'feature-remote-only');
    await cli().addWorktree(clone, target, { kind: 'track', newBranch: localNameForRemote('origin/feature/remote-only'), remoteRef: 'origin/feature/remote-only' });

    expect(existsSync(path.join(target, 'b.txt'))).toBe(true);
    expect(git(target, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/feature/remote-only');
  });

  it('removal is refused without force when the worktree has edits, and the check counts them', async () => {
    const target = path.join(sandbox, 'clone.worktrees', 'feature-remote-only');
    writeFileSync(path.join(target, 'b.txt'), 'edited\n');
    writeFileSync(path.join(target, 'new.txt'), 'untracked\n');

    expect(await checkWorktreeRemoval(cli(), target)).toEqual({ uncommittedFiles: 2, isClaudeWorktree: false });
    await expect(cli().removeWorktree(clone, target, false)).rejects.toThrow();
    expect(existsSync(target)).toBe(true);

    await cli().removeWorktree(clone, target, true);
    expect(existsSync(target)).toBe(false);
    // The branch survives worktree removal.
    expect(git(clone, 'branch', '--list', 'feature/remote-only').trim()).toContain('feature/remote-only');
  });
});

describe('branches', () => {
  it('validates names, creates without switching, and deletes', async () => {
    expect(await cli().isValidBranchName(clone, 'ok/name')).toBe(true);
    expect(await cli().isValidBranchName(clone, 'bad..name')).toBe(false);
    expect(await cli().isValidBranchName(clone, '-leading-dash')).toBe(false);

    await cli().createBranch(clone, 'scratch', 'origin/master');
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('master');
    expect(git(clone, 'rev-parse', 'scratch').trim()).toBe(git(clone, 'rev-parse', 'origin/master').trim());

    await cli().deleteBranch(clone, 'scratch');
    expect(git(clone, 'branch', '--list', 'scratch').trim()).toBe('');
  });

  it('deletion check: blocked when checked out, counts commits not on the default branch', async () => {
    const worktrees = await cli().worktrees(clone);
    expect(await checkBranchDeletion(cli(), clone, 'master', worktrees)).toMatchObject({ kind: 'blocked', checkedOutIn: clone });

    // feature/remote-only has 1 commit not on origin/master.
    expect(await checkBranchDeletion(cli(), clone, 'feature/remote-only', worktrees)).toEqual({
      kind: 'ok',
      comparedWith: 'origin/master',
      unmergedCommits: 1,
    });
  });

  it('switch is blocked by tracked edits, then switches when clean', async () => {
    writeFileSync(path.join(clone, 'a.txt'), 'dirty\n');
    expect(await switchBlockers(cli(), clone)).toBe(1);
    git(clone, 'checkout', '--', 'a.txt');
    writeFileSync(path.join(clone, 'untracked.txt'), 'u\n');
    expect(await switchBlockers(cli(), clone)).toBe(0);

    await cli().switchBranch(clone, { branch: 'feature/remote-only' });
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/remote-only');
    await cli().switchBranch(clone, { branch: 'master' });
  });

  it('switch to a remote branch creates a tracking local branch', async () => {
    git(other, 'switch', '-q', '-c', 'feature/second');
    commit(other, 'd.txt', 'd\n', 'second');
    git(other, 'push', '-q', 'origin', 'feature/second');
    await cli().fetch(clone);

    await cli().switchBranch(clone, { newBranch: 'feature/second', track: 'origin/feature/second' });
    expect(git(clone, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/feature/second');
    await cli().switchBranch(clone, { branch: 'master' });
  });
});

describe('stderr helpers', () => {
  it('redacts credentials embedded in URLs', () => {
    expect(redactUrlCredentials("fatal: unable to access 'https://user:tok3n@bitbucket.org/x.git/'")).toBe(
      "fatal: unable to access 'https://<redacted>@bitbucket.org/x.git/'",
    );
    expect(redactUrlCredentials('https://user@bitbucket.org/x.git')).toBe('https://user@bitbucket.org/x.git');
  });

  it('prefers the fatal/error line over progress output', () => {
    expect(summarizeStderr('Fetching origin\nFrom x\nfatal: could not read Username\n')).toBe('fatal: could not read Username');
    expect(summarizeStderr('just one line\n')).toBe('just one line');
    expect(summarizeStderr('')).toBe('');
  });
});
