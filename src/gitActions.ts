/**
 * gitActions — the git actions offered in the Repositories view: Fetch, Create/Remove Worktree,
 * Create/Delete Branch, Switch Branch (main worktree).
 *
 * Scope is deliberately small: actions taken WHILE reviewing. Commit, push, pull, merge, rebase
 * and stash stay in Cursor's Source Control view.
 *
 * Delete Branch and Remove Worktree accept a multi-selection (and the Delete key): one dialog
 * covers every selected item.
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
import { branchLocation, localBranchName, openChoices, switchTargetFor, worktreeName, type OpenChoice } from './branchLocation';
import { dropConfirmation, stashFiles, stashLabel, type StashFile } from './stashes';
import { revisionUri, sideToUri } from './views/content';
import type { RepoInfo } from './comparison';
import type { GitCli } from './git/gitCli';
import type { RefEntry, WorktreeEntry } from './git/parsers';
import type { Logger } from './logger';
import {
  checkBranchDeletion,
  checkWorktreeRemoval,
  defaultWorktreePath,
  localNameForRemote,
  mapWithConcurrency,
  planBranchDeletions,
  planWorktreeRemovals,
  switchBlockers,
  type BranchCandidate,
  type ConfirmationText,
  type SkippedItem,
  type WorktreeCandidate,
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
  /** Folders open in this window (workspace folders). */
  windowFolders(): readonly string[];
  /**
   * Add a worktree to the editor's Source Control view (git extension API). False when the git
   * extension declined: Cursor and older VS Code (1.90 does; 1.143 does not) only open a repository outside this
   * window's folders when `git.openRepositoryInParentFolders` is `always`.
   */
  openInSourceControl(worktreePath: string): Promise<boolean>;
  /** Setting `gitComparePlus.includeUntracked`, the default for Stash Changes…. */
  includeUntracked(): boolean;
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
  /**
   * "Open…" on a branch: the one action whose result depends on where the branch lives, and says
   * so before doing anything (branchLocation.ts):
   *   - in this window → a message; nothing changes;
   *   - in another worktree → that worktree opens in a new window;
   *   - not checked out → choose: switch this window's worktree (or the main one) to it, or create
   *     a worktree for it and open that.
   */
  async openBranch(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'branch') {
      return;
    }
    const { repo, ref } = node;
    const worktrees = await this.deps.repositories.getWorktrees(repo);
    const location = branchLocation(ref, worktrees, this.deps.windowFolders());
    this.deps.logger.info('open branch requested', { function: 'openBranch', repo: repo.name, ref: ref.name, location: location.kind });
    switch (location.kind) {
      case 'thisWindow':
        void vscode.window.showInformationMessage(`${localBranchName(ref)} is already checked out in this window.`);
        return;
      case 'otherWorktree':
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(location.worktree.path), { forceNewWindow: true });
        return;
      case 'notCheckedOut':
        await this.openUncheckedOutBranch(repo, ref, worktrees, node);
        return;
    }
  }

  private async openUncheckedOutBranch(repo: RepoInfo, ref: RefEntry, worktrees: readonly WorktreeEntry[], node: RepoTreeNode): Promise<void> {
    const target = switchTargetFor(worktrees, this.deps.windowFolders());
    if (target === undefined) {
      return;
    }
    const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { readonly choice: OpenChoice }>(
      openChoices(ref, target.worktree, target.inWindow, repo.root).map((choice) => ({ label: choice.label, detail: choice.detail, choice })),
      { title: `Open ${localBranchName(ref)}: it isn't checked out anywhere yet` },
    );
    if (picked === undefined) {
      return;
    }
    if (picked.choice.action === 'switch') {
      await this.switchWorktreeTo(repo, ref, target.worktree);
    } else {
      await this.createWorktree(node, { openWhenCreated: true });
    }
  }

  /**
   * Create a worktree for a branch.
   * @param options.openWhenCreated - open it in a new window straight away (from Open…) instead
   *   of offering Open / Review afterwards.
   */
  async createWorktree(node: RepoTreeNode | undefined, options: { readonly openWhenCreated?: boolean } = {}): Promise<void> {
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
    if (options.openWhenCreated === true) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
      return;
    }
    const next = await vscode.window.showInformationMessage(`Worktree for ${branchName} created.`, 'Open in New Window', 'Review Against Default');
    if (next === 'Open in New Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    } else if (next === 'Review Against Default') {
      await this.deps.compareWorktree(repo, created);
    }
  }

  /**
   * Remove one or more linked worktrees (multi-select) with ONE confirmation listing what each
   * would lose. Main worktrees in the selection are skipped and listed. Removals run sequentially:
   * they share the repo's administrative files, and git serialises on them anyway.
   */
  async removeWorktrees(nodes: readonly RepoTreeNode[]): Promise<void> {
    const worktreeNodes = nodes.filter((n): n is Extract<RepoTreeNode, { kind: 'worktree' }> => n.kind === 'worktree');
    if (worktreeNodes.length === 0) {
      return;
    }
    const git = await this.deps.getGit();
    const removable = worktreeNodes.filter((n) => !n.isMain);
    const skipped: SkippedItem[] = worktreeNodes
      .filter((n) => n.isMain)
      .map((n) => ({ label: `${n.repo.name} (main worktree)`, reason: 'the main worktree cannot be removed' }));
    const candidates: WorktreeCandidate[] = await Promise.all(
      removable.map(async (n) => ({
        repoName: n.repo.name,
        name: n.worktree.branch ?? path.basename(n.worktree.path),
        path: n.worktree.path,
        detached: n.worktree.branch === undefined,
        check: await checkWorktreeRemoval(git, n.worktree.path),
      })),
    );
    const confirmation = planWorktreeRemovals(candidates, skipped);
    if (confirmation === undefined) {
      void vscode.window.showInformationMessage(skipped.map((s) => `${s.label}: ${s.reason}`).join('\n'));
      return;
    }
    if (!(await confirm(confirmation))) {
      return;
    }

    const failures: string[] = [];
    for (const [index, node] of removable.entries()) {
      const candidate = candidates[index];
      // --force only for worktrees whose uncommitted files the user just confirmed losing.
      const force = (candidate?.check.uncommittedFiles ?? 0) > 0;
      try {
        await git.removeWorktree(node.repo.root, node.worktree.path, force);
        this.deps.logger.info('worktree removed', { function: 'removeWorktrees', repo: node.repo.name, path: node.worktree.path, force, check: candidate?.check });
        await this.forgetWorktree(node.repo, node.worktree.path);
      } catch (error) {
        // Logged here with the item's context; the loop continues so one locked worktree does
        // not prevent removing the rest, and the user gets one summary of what failed.
        this.deps.logger.error('worktree removal failed', error, { function: 'removeWorktrees', repo: node.repo.name, path: node.worktree.path, force, check: candidate?.check });
        failures.push(`${candidate?.name ?? node.worktree.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.refreshRepos(removable.map((n) => n.repo));
    reportFailures('remove', 'worktree', removable.length, failures);
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

  /**
   * Delete one or more local branches (multi-select) with ONE confirmation listing the commits each
   * would lose. Branches checked out in any worktree, and remote branches, are skipped and listed.
   */
  async deleteBranches(nodes: readonly RepoTreeNode[]): Promise<void> {
    const branchNodes = nodes.filter((n): n is Extract<RepoTreeNode, { kind: 'branch' }> => n.kind === 'branch');
    if (branchNodes.length === 0) {
      return;
    }
    const git = await this.deps.getGit();
    const local = branchNodes.filter((n) => n.ref.kind === 'local');
    const remoteSkipped: SkippedItem[] = branchNodes
      .filter((n) => n.ref.kind === 'remote')
      .map((n) => ({ label: n.ref.name, reason: 'remote branch (deleting on the remote is not supported here)' }));

    // Worktree lists fetched once per repo, AFTER any worktree removals in the same action, so a
    // branch freed by removing its worktree is deletable.
    const worktreesByRepo = new Map<string, Promise<WorktreeEntry[]>>();
    const worktreesOf = (repo: RepoInfo): Promise<WorktreeEntry[]> => {
      let pending = worktreesByRepo.get(repo.commonDir);
      if (pending === undefined) {
        pending = git.worktrees(repo.root);
        worktreesByRepo.set(repo.commonDir, pending);
      }
      return pending;
    };
    const candidates: (BranchCandidate & { node: (typeof local)[number] })[] = await Promise.all(
      local.map(async (node) => ({
        node,
        repoName: node.repo.name,
        branch: node.ref.name,
        check: await checkBranchDeletion(git, node.repo.root, node.ref.name, await worktreesOf(node.repo)),
      })),
    );
    const plan = planBranchDeletions(candidates, remoteSkipped);
    if (plan.confirmation === undefined) {
      void vscode.window.showInformationMessage(`Nothing to delete. ${plan.skipped.map((s) => `${s.label}: ${s.reason}`).join('; ')}`);
      return;
    }
    if (!(await confirm(plan.confirmation))) {
      return;
    }

    const deletable = new Set(plan.deletable);
    const toDelete = candidates.filter((c) => deletable.has(c));
    const failures: string[] = [];
    for (const { node, check } of toDelete) {
      try {
        await git.deleteBranch(node.repo.root, node.ref.name);
        this.deps.logger.info('branch deleted', { function: 'deleteBranches', repo: node.repo.name, branch: node.ref.name, sha: node.ref.sha, check });
        const base = this.deps.bases.get(node.repo.commonDir);
        if (base?.kind === 'ref' && base.ref === node.ref.name) {
          await this.deps.bases.clear(node.repo.commonDir);
        }
      } catch (error) {
        // Logged per branch with its context; continue so one failure does not block the rest.
        this.deps.logger.error('branch deletion failed', error, { function: 'deleteBranches', repo: node.repo.name, branch: node.ref.name, check });
        failures.push(`${node.ref.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.refreshRepos(toDelete.map((c) => c.node.repo));
    reportFailures('delete', 'branch', toDelete.length, failures);
  }

  /**
   * Delete key / "Delete Selected": remove selected worktrees first, then delete selected branches.
   * That order lets one action remove a worktree and the branch it had checked out.
   */
  async deleteSelection(nodes: readonly RepoTreeNode[]): Promise<void> {
    await this.removeWorktrees(nodes);
    await this.deleteBranches(nodes);
  }

  /** Switch the MAIN worktree to a branch; refused while it has uncommitted tracked changes. */
  async switchBranch(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'branch') {
      return;
    }
    const main = (await this.deps.repositories.getWorktrees(node.repo))[0];
    if (main !== undefined) {
      await this.switchWorktreeTo(node.repo, node.ref, main);
    }
  }

  /**
   * Switch one worktree to a branch (an existing local branch, or a new local one tracking a
   * remote branch). Refused while that worktree has uncommitted tracked changes: switching would
   * carry them along or fail half-way, and nothing is stashed for the user.
   */
  private async switchWorktreeTo(repo: RepoInfo, ref: RefEntry, worktree: WorktreeEntry): Promise<void> {
    const git = await this.deps.getGit();
    const where = worktreeName(worktree, repo.root);
    const blockers = await switchBlockers(git, worktree.path);
    if (blockers > 0) {
      void vscode.window.showWarningMessage(
        `The ${where} of ${repo.name} has ${blockers} uncommitted change${blockers === 1 ? '' : 's'}. Commit ${blockers === 1 ? 'it' : 'them'} in Source Control, or right-click the worktree → Stash Changes…, first; or create a worktree for the branch instead.`,
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
      await git.switchBranch(worktree.path, target);
    } catch (error) {
      this.deps.logger.error('branch switch failed', error, { function: 'switchWorktreeTo', repo: repo.name, worktree: worktree.path, target });
      throw error;
    }
    this.deps.logger.info('branch switched', { function: 'switchWorktreeTo', repo: repo.name, worktree: worktree.path, target });
    this.deps.repositories.refreshRepo(repo);
  }

  /**
   * "Open in Source Control": make a worktree's changes committable from the editor's own Source
   * Control view in this window, without opening another window. Commit, push and the rest then
   * happen there, with everything the editor offers; this extension does not reimplement them.
   */
  async openInSourceControl(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'worktree') {
      return;
    }
    const { repo, worktree } = node;
    if (await this.deps.openInSourceControl(worktree.path)) {
      this.deps.logger.info('worktree opened in source control', { function: 'openInSourceControl', repo: repo.name, worktree: worktree.path });
      await vscode.commands.executeCommand('workbench.view.scm');
      return;
    }
    // The git extension refused (see GitActionsDeps.openInSourceControl): Source Control only
    // lists repositories inside this window's folders. Offer the two ways that always work.
    this.deps.logger.warn('source control declined worktree', { function: 'openInSourceControl', repo: repo.name, worktree: worktree.path });
    const addHere = 'Add to This Window';
    const openWindow = 'Open in New Window';
    const picked = await vscode.window.showWarningMessage(
      `Source Control here only lists repositories inside this window's folders, and ${worktreeName(worktree, repo.root)} is outside them. ` +
        'Add it to this window as a folder, or open it in its own window.',
      addHere,
      openWindow,
    );
    if (picked === addHere) {
      const end = vscode.workspace.workspaceFolders?.length ?? 0;
      vscode.workspace.updateWorkspaceFolders(end, 0, { uri: vscode.Uri.file(worktree.path) });
      this.deps.logger.info('worktree added to window', { function: 'openInSourceControl', repo: repo.name, worktree: worktree.path });
      await vscode.commands.executeCommand('workbench.view.scm');
    } else if (picked === openWindow) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), { forceNewWindow: true });
    }
  }

  /**
   * "Stash Changes…" on a worktree: asks for an optional name and whether to include untracked
   * files (showing how many of each), then `git stash push` in that worktree. Its files go back to
   * the last commit; the stash appears under Stashes.
   */
  async stashChanges(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'worktree') {
      return;
    }
    const { repo, worktree } = node;
    const git = await this.deps.getGit();
    const counts = await git.statusCounts(worktree.path, true);
    const tracked = counts.total - counts.untracked;
    if (counts.total === 0) {
      void vscode.window.showInformationMessage(`${worktreeName(worktree, repo.root)} has no uncommitted changes to stash.`);
      return;
    }
    const choices = [
      ...(tracked > 0 ? [{ label: '$(archive) Stash changes to tracked files', description: `${tracked} file${tracked === 1 ? '' : 's'}`, detail: 'Untracked files stay where they are.', includeUntracked: false }] : []),
      ...(counts.untracked > 0
        ? [{ label: '$(archive) Stash everything, including untracked files', description: `${counts.total} file${counts.total === 1 ? '' : 's'}`, detail: `Includes ${counts.untracked} untracked file${counts.untracked === 1 ? '' : 's'}.`, includeUntracked: true }]
        : []),
    ];
    // The setting decides which comes first; with only one kind of change there is one choice.
    const ordered = this.deps.includeUntracked() ? [...choices].reverse() : choices;
    const picked = ordered.length === 1 ? ordered[0] : await vscode.window.showQuickPick(ordered, { title: `Stash the uncommitted changes in ${worktreeName(worktree, repo.root)}` });
    if (picked === undefined) {
      return;
    }
    const message = await vscode.window.showInputBox({
      title: 'Stash name (optional)',
      prompt: `The files go back to the last commit; the stash appears under Stashes. Leave empty for git's default name.`,
    });
    if (message === undefined) {
      return;
    }
    try {
      await git.stashPush(worktree.path, message.trim(), picked.includeUntracked);
    } catch (error) {
      this.deps.logger.error('stash failed', error, { function: 'stashChanges', repo: repo.name, worktree: worktree.path, includeUntracked: picked.includeUntracked });
      throw error;
    }
    this.deps.logger.info('changes stashed', { function: 'stashChanges', repo: repo.name, worktree: worktree.path, includeUntracked: picked.includeUntracked, fileCount: picked.includeUntracked ? counts.total : tracked });
    this.deps.repositories.refreshRepo(repo);
  }

  /**
   * Apply (keep the stash) or Pop (apply, then remove it) to this window's worktree of the repo,
   * or the main worktree when none is open here; the message names which. git refuses when the
   * stash conflicts with uncommitted changes there, and Pop then keeps the stash.
   */
  async applyStash(node: RepoTreeNode | undefined, mode: 'apply' | 'pop'): Promise<void> {
    if (node?.kind !== 'stash') {
      return;
    }
    const { repo, stash } = node;
    const git = await this.deps.getGit();
    const target = switchTargetFor(await this.deps.repositories.getWorktrees(repo), this.deps.windowFolders());
    if (target === undefined) {
      return;
    }
    const where = target.inWindow ? "this window's worktree" : `the ${worktreeName(target.worktree, repo.root)}`;
    try {
      if (mode === 'apply') {
        await git.stashApply(target.worktree.path, stash.sha);
      } else {
        // stash@{n} shifts when stashes are added or removed: look it up by SHA right now.
        const ref = await git.stashRefFor(repo.root, stash.sha);
        if (ref === undefined) {
          void vscode.window.showInformationMessage('That stash no longer exists.');
          this.deps.repositories.refreshRepo(repo);
          return;
        }
        await git.stashPop(target.worktree.path, ref);
      }
    } catch (error) {
      this.deps.logger.error('stash apply failed', error, { function: 'applyStash', repo: repo.name, mode, stash: stash.sha, worktree: target.worktree.path });
      this.deps.repositories.refreshRepo(repo);
      throw error;
    }
    this.deps.logger.info('stash applied', { function: 'applyStash', repo: repo.name, mode, stash: stash.sha, worktree: target.worktree.path });
    this.deps.repositories.refreshRepo(repo);
    void vscode.window.showInformationMessage(`${mode === 'pop' ? 'Popped' : 'Applied'} "${stashLabel(stash)}" to ${where}.${mode === 'pop' ? ' The stash was removed.' : ' The stash was kept.'}`);
  }

  /** Drop a stash after a modal confirmation that says how many files are lost. */
  async dropStash(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'stash') {
      return;
    }
    const { repo, stash } = node;
    const git = await this.deps.getGit();
    const files = await stashFiles(git, repo.root, stash);
    if (!(await confirm(dropConfirmation(stash, files.length)))) {
      return;
    }
    const ref = await git.stashRefFor(repo.root, stash.sha);
    if (ref === undefined) {
      void vscode.window.showInformationMessage('That stash no longer exists.');
      this.deps.repositories.refreshRepo(repo);
      return;
    }
    try {
      await git.stashDrop(repo.root, ref);
    } catch (error) {
      this.deps.logger.error('stash drop failed', error, { function: 'dropStash', repo: repo.name, stash: stash.sha, ref });
      throw error;
    }
    this.deps.logger.info('stash dropped', { function: 'dropStash', repo: repo.name, stash: stash.sha, ref, fileCount: files.length });
    this.deps.repositories.refreshRepo(repo);
  }

  /** One file of a stash: before (the commit it was made on) vs in the stash. */
  async openStashFile(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'stashFile') {
      return;
    }
    const [left, right] = stashFileUris(node.repo.root, node.entry);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(node.entry.file.path)} (before ↔ stash)`);
  }

  /** Every file of a stash in one multi-file diff. */
  async openStashChanges(node: RepoTreeNode | undefined): Promise<void> {
    if (node?.kind !== 'stash') {
      return;
    }
    const files = await stashFiles(await this.deps.getGit(), node.repo.root, node.stash);
    if (files.length === 0) {
      void vscode.window.showInformationMessage('This stash has no file changes.');
      return;
    }
    const entries = files.map((entry) => {
      const [left, right] = stashFileUris(node.repo.root, entry);
      return [right, entry.leftRevision === undefined || entry.file.status === 'added' ? undefined : left, entry.file.status === 'deleted' ? undefined : right];
    });
    await vscode.commands.executeCommand('vscode.changes', `Stash: ${stashLabel(node.stash)}`, entries);
  }

  private refreshRepos(repos: readonly RepoInfo[]): void {
    for (const repo of new Map(repos.map((r) => [r.commonDir, r])).values()) {
      this.deps.repositories.refreshRepo(repo);
    }
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

/** Show a modal confirmation; true only when the user clicked the confirm button. */
async function confirm(text: ConfirmationText): Promise<boolean> {
  return (await vscode.window.showWarningMessage(text.title, { modal: true, detail: text.detail }, text.confirm)) === text.confirm;
}

/** One summary for a bulk action's failures (each already logged at ERROR with its context). */
function reportFailures(verb: string, noun: string, attempted: number, failures: readonly string[]): void {
  if (failures.length > 0) {
    void vscode.window.showWarningMessage(`Could not ${verb} ${failures.length} of ${attempted} ${noun}${attempted === 1 ? '' : noun.endsWith('h') ? 'es' : 's'}`, {
      modal: false,
      detail: failures.join('\n'),
    });
  }
}

// Left = the file before the stash (empty for files the stash added), right = the file in it.
function stashFileUris(root: string, entry: StashFile): [vscode.Uri, vscode.Uri] {
  const { file } = entry;
  const left =
    entry.leftRevision === undefined || file.status === 'added' || file.status === 'untracked'
      ? sideToUri({ kind: 'empty' }, file.path)
      : revisionUri(root, entry.leftRevision, file.oldPath);
  const right = file.status === 'deleted' ? sideToUri({ kind: 'empty' }, file.path) : revisionUri(root, entry.rightRevision, file.path);
  return [left, right];
}
