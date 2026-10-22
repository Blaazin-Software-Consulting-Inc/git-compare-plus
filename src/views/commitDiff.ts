/**
 * commitDiff — opening diffs for commits: one commit's whole change set in a multi-file diff, and
 * the entries format `vscode.changes` expects.
 *
 * Shared by the Commits group in Changes (extension.ts) and the blame hover (blameController.ts),
 * so "open this commit" looks the same wherever it is clicked.
 */
import * as vscode from 'vscode';
import { diffSides, type ComparisonResult, type RepoInfo } from '../comparison';
import type { GitCli } from '../git/gitCli';
import type { ChangedFile, CommitEntry } from '../git/parsers';
import type { Logger } from '../logger';
import { commitTitle } from './commitText';
import { sideToUri } from './content';

/**
 * Entries for `vscode.changes` (one multi-file diff editor): `[label uri, left, right]` per file,
 * with `undefined` for an empty side (added / deleted).
 */
export function multiDiffEntries(nodes: readonly { readonly result: ComparisonResult; readonly file: ChangedFile }[]): (vscode.Uri | undefined)[][] {
  return nodes.map(({ result, file }) => {
    const { left, right } = diffSides(result, file);
    const leftUri = left.kind === 'empty' ? undefined : sideToUri(left, file.oldPath);
    const rightUri = right.kind === 'empty' ? undefined : sideToUri(right, file.path);
    // First element labels the entry; prefer the subject side, which exists unless deleted.
    return [rightUri ?? leftUri, leftUri, rightUri];
  });
}

/**
 * Open every file `commit` changed, against its first parent, in one multi-file diff.
 * @param cwd - a worktree of the repo (git reads the commit from the shared object store).
 * Shows a message instead for a root commit (nothing before it) or a commit with no file changes.
 */
export async function openCommitChanges(git: GitCli, repo: RepoInfo, cwd: string, commit: CommitEntry, logger: Logger): Promise<void> {
  const parent = commit.parents[0];
  if (parent === undefined) {
    void vscode.window.showInformationMessage(`${commitTitle(commit)} is the first commit of the history: there is no earlier version to compare it with.`);
    return;
  }
  const files = await git.diffNameStatus(cwd, parent, commit.sha);
  logger.info('commit opened', { function: 'openCommitChanges', repo: repo.name, sha: commit.sha, parent, fileCount: files.length });
  if (files.length === 0) {
    void vscode.window.showInformationMessage(`${commitTitle(commit)} changes no files.`);
    return;
  }
  // A one-commit comparison: left = first parent, right = the commit, both read from git.
  const commitResult: ComparisonResult = {
    repo: { ...repo, root: cwd },
    subject: { kind: 'ref', ref: commit.sha, label: commitTitle(commit), refKind: 'commit' },
    outcome: 'compared',
    mode: 'direct',
    baseLabel: `${commit.sha.slice(0, 7)}^`,
    baseRevision: parent,
    subjectRevision: commit.sha,
    excludedUncommitted: {},
    files,
  };
  await vscode.commands.executeCommand('vscode.changes', commitTitle(commit), multiDiffEntries(files.map((file) => ({ result: commitResult, file }))));
}
