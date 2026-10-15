/**
 * gitActions — the git actions offered in the Repositories view: Fetch, Create/Remove Worktree,
 * Create/Delete Branch, Switch Branch (main worktree).
 *
 * Scope is deliberately small: actions taken WHILE reviewing. Commit, push, pull, merge, rebase
 * and stash stay in Cursor's Source Control view.
 *
 * Every destructive action follows inspect → confirm → act:
 *   - the inspect step is in operations.ts (counts of what would be lost, blocking conditions);
 *   - the confirmation is a modal dialog naming exactly what is lost ("4 uncommitted files");
 *   - only then is the forcing git flag used.
 * Each action logs INFO on success with its inputs and ERROR at the failure site with context.
 *
 * See also: src/operations.ts (safety checks), src/git/gitCli.ts (git commands).
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BaseStore } from './baseStore';
import type { RepoInfo } from './comparison';
import type { GitCli } from './git/gitCli';
import type { WorktreeEntry } from './git/parsers';
import type { Logger } from './logger';
import {
  checkBranchDeletion,
  checkWorktreeRemoval,
  defaultWorktreePath,
  localNameForRemote,
  mapWithConcurrency,
  switchBlockers,
} from './operations';
import type { ChangesProvider } from './views/changesView';
import type { RepositoriesProvider, RepoTreeNode } from './views/repositoriesView';

// Parallel fetches: enough to make "Fetch All" on ~11 repos quick, few enough not to trip the
// remote host's rate limiting or saturate a VPN.
const FETCH_CONCURRENCY = 4;

/** Collaborators for the actions. */
export interface GitActionsDeps {
  getGit(): Promise<GitCli>;
  readonly repositories: RepositoriesProvider;
  readonly changes: ChangesProvider;
  readonly bases: BaseStore;
  readonly logger: Logger;
  /** Start a comparison for a freshly created worktree (CompareCommands.compareNode). */
  compareWorktree(repo: RepoInfo, worktree: WorktreeEntry): Promise<void>;
}

/** Implementations of the git action commands. */
export class GitActions {
  constructor(private readonly deps: GitActionsDeps) {}

  /** Fetch one repo (repo right-click). */
  async fetchRepo(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'repo') {
      return;
    }
    await this.fetchRepos([node.repo]);
  }

  /** Fetch every repo in the window (Repositories title bar). */
  async fetchAll(): Promise<void> {
    await this.fetchRepos(await this.deps.repositories.getRepos());
  }

  /**
   * Fetch the given repos with bounded concurrency, refreshing each row as it completes.
   * @returns the repos that failed (already logged at ERROR by GitCli.fetch and reported to the user).
   */
  async fetchRepos(repos: readonly RepoInfo[]): Promise<RepoInfo[]> {
    const git = await this.deps.getGit();
    let done = 0;
    const settled = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Fetching', cancellable: false },
      (progress) =>
        mapWithConcurrency(repos, FETCH_CONCURRENCY, async (repo) => {
          try {
            await git.fetch(repo.root);
          } finally {
            done++;
            progress.report({ message: `${done} of ${repos.length}`, increment: 100 / repos.length });
            this.deps.repositories.refreshRepo(repo);
          }
        }),
    );
    const failed = repos.filter((_, i) => settled[i]?.status === 'rejected');
    if (failed.length > 0) {
      const reasons = failed.map((repo) => {
        const result = settled[repos.indexOf(repo)];
        const reason = result?.status === 'rejected' && result.reason instanceof Error ? result.reason.message : 'unknown error';
        return `${repo.name}: ${reason}`;
      });
      void vscode.window.showWarningMessage(`Fetch failed for ${failed.length} of ${repos.length} repos`, { modal: false, detail: reasons.join('\n') });
    }
    return failed;
  }

  /** Create a worktree for a branch (local, or a new local branch tracking a remote one). */
  async createWorktree(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'branch') {
      return;
    }
    const { repo, ref } = node;
    const git = await this.deps.getGit();
    const worktrees = await git.worktrees(repo.root);

    // A remote branch gets a local branch of the same short name; reuse it if it already exists.
    let checkout: { kind: 'existing'; branch: string } | { kind: 'track'; newBranch: string; remoteRef: string };
    if (ref.kind === 'remote') {
      const localName = localNameForRemote(ref.name);
      const localExists = (await this.deps.repositories.getRefs(repo)).some((r) => r.kind === 'local' && r.name === localName);
      checkout = localExists ? { kind: 'existing', branch: localName } : { kind: 'track', newBranch: localName, remoteRef: ref.name };
    } else {
      checkout = { kind: 'existing', branch: ref.name };
    }
    const branchName = checkout.kind === 'existing' ? checkout.branch : checkout.newBranch;
    const holder = worktrees.find((w) => w.branch === branchName);
    if (holder !== undefined) {
      void vscode.window.showInformationMessage(`${branchName} is already checked out in ${holder.path}.`);
      return;
    }

    const worktreePath = await vscode.window.showInputBox({
      title: `New worktree for ${branchName}`,
      prompt: checkout.kind === 'track' ? `Creates local branch ${branchName} tracking ${ref.name}.` : `Checks out ${branchName}.`,
      value: defaultWorktreePath(repo.root, branchName),
      validateInput: (value) => (value.trim() === '' ? 'Enter a folder' : existsSync(value.trim()) ? 'That folder already exists' : undefined),
    });
    if (worktreePath === undefined) {
      return;
    }
    const target = worktreePath.trim();
    try {
      await git.addWorktree(repo.root, target, checkout);
    } catch (error) {
      this.deps.logger.error('worktree creation failed', error, { function: 'createWorktree', repo: repo.name, target, checkout });
      throw error;
    }
    this.deps.logger.info('worktree created', { function: 'createWorktree', repo: repo.name, path: target, checkout });
    this.deps.repositories.refreshRepo(repo);

    const created: WorktreeEntry = { path: target, branch: branchName, detached: false, bare: false, prunable: false };
    const next = await vscode.window.showInformationMessage(`Worktree for ${branchName} created.`, 'Open in New Window', 'Compare With Base');
    if (next === 'Open in New Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    } else if (next === 'Compare With Base') {
      await this.deps.compareWorktree(repo, created);
    }
  }

  /** Remove a linked worktree, confirming exactly what would be lost. */
  async removeWorktree(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'worktree' || node.isMain) {
      return;
    }
    const { repo, worktree } = node;
    const git = await this.deps.getGit();
    const check = await checkWorktreeRemoval(git, worktree.path);
    const name = worktree.branch ?? path.basename(worktree.path);

    const lines = [
      `Deletes the folder ${worktree.path}.`,
      worktree.branch !== undefined ? `The branch ${worktree.branch} and its commits are kept.` : 'The worktree is detached; commits not on any branch become unreachable.',
      ...(check.uncommittedFiles > 0 ? [`${check.uncommittedFiles} uncommitted file${check.uncommittedFiles === 1 ? '' : 's'} will be PERMANENTLY DELETED.`] : []),
      ...(check.isClaudeWorktree ? ['This worktree was created by Claude Code. If a Claude session is still using it, that session will break.'] : []),
    ];
    const confirm = check.uncommittedFiles > 0 ? `Remove and Discard ${check.uncommittedFiles} File${check.uncommittedFiles === 1 ? '' : 's'}` : 'Remove Worktree';
    const answer = await vscode.window.showWarningMessage(`Remove worktree ${name}?`, { modal: true, detail: lines.join('\n') }, confirm);
    if (answer !== confirm) {
      return;
    }

    // --force only when the user just confirmed losing exactly these files.
    const force = check.uncommittedFiles > 0;
    try {
      await git.removeWorktree(repo.root, worktree.path, force);
    } catch (error) {
      this.deps.logger.error('worktree removal failed', error, { function: 'removeWorktree', repo: repo.name, path: worktree.path, force, check });
      throw error;
    }
    this.deps.logger.info('worktree removed', { function: 'removeWorktree', repo: repo.name, path: worktree.path, force, check });
    await this.forgetWorktree(repo, worktree.path);
    this.deps.repositories.refreshRepo(repo);
  }

  /** Create a branch starting at a branch, a worktree's HEAD, or the main worktree's HEAD. */
  async createBranch(node: RepoTreeNode | undefined): Promise<void> {
    if (node === undefined || node.kind === 'message' || node.kind === 'group') {
      return;
    }
    const { repo } = node;
    const git = await this.deps.getGit();
    // Start point: a branch by name; a worktree (or repo = main worktree) by its current commit.
    const worktreeRoot = node.kind === 'worktree' ? node.worktree.path : node.kind === 'repo' ? repo.root : undefined;
    const startPoint = node.kind === 'branch' ? node.ref.name : ((await git.resolveCommit(worktreeRoot ?? repo.root, 'HEAD')) ?? 'HEAD');
    const startLabel = node.kind === 'branch' ? node.ref.name : `${node.kind === 'worktree' ? (node.worktree.branch ?? 'worktree') : repo.name} (current commit)`;

    const name = await vscode.window.showInputBox({
      title: `New branch from ${startLabel}`,
      prompt: 'The branch is created without switching to it.',
      validateInput: async (value) => {
        const trimmed = value.trim();
        if (trimmed === '') {
          return 'Enter a branch name';
        }
        if ((await this.deps.repositories.getRefs(repo)).some((r) => r.kind === 'local' && r.name === trimmed)) {
          return 'A branch with that name already exists';
        }
        return (await git.isValidBranchName(repo.root, trimmed)) ? undefined : 'Not a valid git branch name';
      },
    });
    if (name === undefined) {
      return;
    }
    const branch = name.trim();
    try {
      await git.createBranch(repo.root, branch, startPoint);
    } catch (error) {
      this.deps.logger.error('branch creation failed', error, { function: 'createBranch', repo: repo.name, branch, startPoint });
      throw error;
    }
    this.deps.logger.info('branch created', { function: 'createBranch', repo: repo.name, branch, startPoint });
    this.deps.repositories.refreshRepo(repo);

    const next = await vscode.window.showInformationMessage(`Branch ${branch} created from ${startLabel}.`, 'Create Worktree');
    if (next === 'Create Worktree') {
      await this.createWorktree({ kind: 'branch', repo, ref: { name: branch, kind: 'local', sha: '', isHead: false } });
    }
  }

  /** Delete a local branch after checking it is not checked out and confirming unmerged commits. */
  async deleteBranch(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'branch' || node.ref.kind !== 'local') {
      return;
    }
    const { repo, ref } = node;
    const git = await this.deps.getGit();
    const check = await checkBranchDeletion(git, repo.root, ref.name, await git.worktrees(repo.root));

    if (check.kind === 'blocked') {
      void vscode.window.showInformationMessage(`${ref.name} is checked out in ${check.checkedOutIn}. Remove that worktree or switch it to another branch first.`);
      return;
    }
    let detail: string;
    let confirm: string;
    if (check.kind === 'unknown') {
      detail = `Could not check for unmerged commits (${check.reason}). Commits only on this branch would be lost.`;
      confirm = 'Delete Anyway';
    } else if (check.unmergedCommits > 0) {
      detail = `${check.unmergedCommits} commit${check.unmergedCommits === 1 ? ' is' : 's are'} not in ${check.comparedWith} and will be lost (recoverable from the reflog for a limited time).`;
      confirm = `Delete and Lose ${check.unmergedCommits} Commit${check.unmergedCommits === 1 ? '' : 's'}`;
    } else {
      detail = `All of its commits are in ${check.comparedWith}. Remote branches are not affected.`;
      confirm = 'Delete Branch';
    }
    const answer = await vscode.window.showWarningMessage(`Delete branch ${ref.name}?`, { modal: true, detail }, confirm);
    if (answer !== confirm) {
      return;
    }
    try {
      await git.deleteBranch(repo.root, ref.name);
    } catch (error) {
      this.deps.logger.error('branch deletion failed', error, { function: 'deleteBranch', repo: repo.name, branch: ref.name, check });
      throw error;
    }
    this.deps.logger.info('branch deleted', { function: 'deleteBranch', repo: repo.name, branch: ref.name, sha: ref.sha, check });
    const base = this.deps.bases.get(repo.commonDir);
    if (base?.kind === 'ref' && base.ref === ref.name) {
      await this.deps.bases.clear(repo.commonDir);
    }
    this.deps.repositories.refreshRepo(repo);
  }

  /** Switch the MAIN worktree to a branch; refused while it has uncommitted tracked changes. */
  async switchBranch(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'branch') {
      return;
    }
    const { repo, ref } = node;
    const git = await this.deps.getGit();
    const blockers = await switchBlockers(git, repo.root);
    if (blockers > 0) {
      void vscode.window.showWarningMessage(
        `The main worktree of ${repo.name} has ${blockers} uncommitted change${blockers === 1 ? '' : 's'}. Commit or stash ${blockers === 1 ? 'it' : 'them'} in Source Control first.`,
      );
      return;
    }
    let target: { branch: string } | { newBranch: string; track: string };
    if (ref.kind === 'remote') {
      const localName = localNameForRemote(ref.name);
      const localExists = (await this.deps.repositories.getRefs(repo)).some((r) => r.kind === 'local' && r.name === localName);
      target = localExists ? { branch: localName } : { newBranch: localName, track: ref.name };
    } else {
      target = { branch: ref.name };
    }
    try {
      await git.switchBranch(repo.root, target);
    } catch (error) {
      this.deps.logger.error('branch switch failed', error, { function: 'switchBranch', repo: repo.name, target });
      throw error;
    }
    this.deps.logger.info('branch switched', { function: 'switchBranch', repo: repo.name, target });
    this.deps.repositories.refreshRepo(repo);
  }

  // A removed worktree must not linger as the saved comparison base or as the subject on display.
  private async forgetWorktree(repo: RepoInfo, worktreePath: string): Promise<void> {
    const base = this.deps.bases.get(repo.commonDir);
    if (base?.kind === 'worktree' && base.root === worktreePath) {
      await this.deps.bases.clear(repo.commonDir);
    }
    const shown = this.deps.changes.current();
    if (shown?.setup.requests.some((r) => r.subject.kind === 'worktree' && r.subject.root === worktreePath)) {
      this.deps.changes.clear();
    }
  }
}
