/**
 * commitsView — the "Commits" view: the commits of the worktree or branch selected in
 * Repositories (branchCommits.ts), search results, and the details of any commit opened from
 * elsewhere (Show Commit Details on the Commits group in Changes, the History view, or here).
 *
 * Selection follows Repositories only while this view is visible; a selection made while it is
 * hidden is loaded when it is shown. The title bar toggles between "commits not on the default
 * Against" and the full history. The same selection also shows in Changes (extension.ts,
 * CompareCommands.showSelected).
 *
 * For a worktree, an "Uncommitted changes · N files" row comes first: what is on disk but not
 * committed (against its last commit), with the usual badges and line counts; its Review button
 * opens them in Changes. Uncommitted work is not a commit, so it is never mixed into the list.
 *
 * Each commit row expands to its details: author and date, its parent(s) (click one to show its
 * details), and the files it changed, with A/M/D/R badges, line counts and diff bars as in Changes.
 * Clicking a file opens its diff (first parent ↔ commit). The full message is the row's hover.
 *
 * Files and messages are loaded when a row is expanded, once per commit. Nothing runs while the
 * view is empty or hidden.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { diffSides, runComparisons, type BaseSpec, type ComparisonResult, type RepoInfo, type Subject } from '../comparison';
import type { ComparisonSetup } from '../views/changesHeader';
import type { GitCli } from '../git/gitCli';
import type { ChangedFile, CommitEntry } from '../git/parsers';
import type { Logger } from '../logger';
import { formatAge } from '../operations';
import { commitDescription, commitTitle } from '../views/commitText';
import { sideToUri } from '../views/content';
import { changedFileUri, diffBarIcon } from '../views/changesView';
import { fileLineStatsText } from '../views/lineStatsText';
import { loadBranchCommits, type BranchCommitsMode, type BranchCommitsRequest } from './branchCommits';
import { SEARCH_KINDS, SEARCH_LIMIT, searchArgs, searchDescription, type CommitQuery } from './commitSearch';
import type { CommitTarget } from './commitTarget';

/** Collaborators from extension.ts. */
export interface CommitsViewDeps {
  getGit(): Promise<GitCli>;
  /** Which repo to search in (skipped when there is one). */
  pickRepository(): Promise<RepoInfo | undefined>;
  readonly extensionUri: vscode.Uri;
  /** Setting `gitComparePlus.includeUntracked`. */
  includeUntracked(): boolean;
  /** Show a comparison in Changes (the Uncommitted changes row's Review). */
  review(setup: ComparisonSetup): Promise<void>;
  readonly logger: Logger;
}

/** Tree nodes. `commit` nodes are what the shared commit actions (commitActions.ts) act on. */
export type CommitsNode =
  | { readonly kind: 'commit'; readonly target: CommitTarget; readonly expanded: boolean }
  | { readonly kind: 'info'; readonly text: string; readonly icon: string; readonly tooltip?: string }
  | { readonly kind: 'parent'; readonly target: CommitTarget; readonly label: string }
  | { readonly kind: 'file'; readonly target: CommitTarget; readonly file: ChangedFile; readonly parentRevision: string }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'uncommitted'; readonly result: ComparisonResult }
  | { readonly kind: 'uncommittedFile'; readonly result: ComparisonResult; readonly file: ChangedFile };

/** One commit's loaded details. */
interface CommitDetails {
  readonly parents: readonly CommitEntry[];
  readonly files: readonly ChangedFile[];
  readonly message: string;
  /** What the files are compared against: the first parent, or the empty tree for a root commit. */
  readonly parentRevision: string;
}

/** The Commits view. */
export class CommitsView implements vscode.TreeDataProvider<CommitsNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<CommitsNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly view: vscode.TreeView<CommitsNode>;
  private commits: readonly CommitTarget[] = [];
  private emptyText: string | undefined;
  // Single-commit details open expanded; search results open collapsed.
  private expandAll = false;
  private readonly details = new Map<string, Promise<CommitDetails>>();
  private readonly subscriptions: vscode.Disposable[];
  // The selected worktree/branch being listed (or waiting for the view to be shown), and how.
  private branch: { readonly repo: RepoInfo; readonly request: BranchCommitsRequest } | undefined;
  private branchPending = false;
  private branchMode: BranchCommitsMode = 'auto';
  // Drops a slow load whose selection has since been replaced.
  private branchGeneration = 0;
  // The selected worktree's uncommitted changes (against its last commit); undefined when clean.
  private uncommitted: ComparisonResult | undefined;

  constructor(private readonly deps: CommitsViewDeps) {
    this.view = vscode.window.createTreeView('gitComparePlus.commits', { treeDataProvider: this, canSelectMany: true, showCollapseAll: true });
    this.subscriptions = [
      this.view,
      vscode.commands.registerCommand('gitComparePlus.commits.search', () => this.guard('search', () => this.search())),
      vscode.commands.registerCommand('gitComparePlus.commits.openFile', (node?: CommitsNode) => this.guard('openFile', () => this.openFile(node))),
      vscode.commands.registerCommand('gitComparePlus.commits.openUncommittedFile', (node?: CommitsNode) => this.guard('openUncommittedFile', () => this.openUncommittedFile(node))),
      vscode.commands.registerCommand('gitComparePlus.commits.reviewUncommitted', (node?: CommitsNode) => this.guard('reviewUncommitted', () => this.reviewUncommitted(node))),
      vscode.commands.registerCommand('gitComparePlus.commits.clear', () => {
        this.branch = undefined;
        this.show([], undefined, false);
      }),
      vscode.commands.registerCommand('gitComparePlus.commits.showFullHistory', () => this.guard('showFullHistory', () => this.setBranchMode('history'))),
      vscode.commands.registerCommand('gitComparePlus.commits.showAheadOnly', () => this.guard('showAheadOnly', () => this.setBranchMode('auto'))),
      this.view.onDidChangeVisibility((event) => {
        if (event.visible && this.branchPending) {
          void this.guard('loadBranch', () => this.loadBranch());
        }
      }),
    ];
  }

  /**
   * A worktree or branch was selected in Repositories: list its commits (see branchCommits.ts).
   * Runs git only if this view is visible; otherwise remembers the selection for when it is.
   */
  async showBranch(repo: RepoInfo, request: BranchCommitsRequest): Promise<void> {
    this.branch = { repo, request };
    if (!this.view.visible) {
      this.branchPending = true;
      return;
    }
    await this.loadBranch();
  }

  // The worktree's edits against its own last commit: the same comparison Changes would run, so
  // line counts and file kinds match. Best-effort: on failure the commits are still listed (WARN).
  private async loadUncommitted(git: GitCli, repo: RepoInfo, request: BranchCommitsRequest): Promise<ComparisonResult | undefined> {
    if (request.worktree === undefined) {
      return undefined;
    }
    const [result] = await runComparisons(git, [{ repo, subject: uncommittedSubject(request.worktree) }], LAST_COMMIT, 'direct', {
      includeUntracked: this.deps.includeUntracked(),
      logger: this.deps.logger,
    });
    if (result === undefined || result.outcome !== 'compared') {
      this.deps.logger.warn('uncommitted changes unavailable', { function: 'loadUncommitted', repo: repo.name, worktree: request.worktree.root, outcome: result?.outcome });
      return undefined;
    }
    return result.files.length > 0 ? result : undefined;
  }

  private async setBranchMode(mode: BranchCommitsMode): Promise<void> {
    this.branchMode = mode;
    if (this.branch !== undefined) {
      await this.loadBranch();
    }
  }

  private async loadBranch(): Promise<void> {
    const selected = this.branch;
    this.branchPending = false;
    if (selected === undefined) {
      return;
    }
    const generation = ++this.branchGeneration;
    this.view.description = 'loading…';
    const startedAt = Date.now();
    const git = await this.deps.getGit();
    const [list, uncommitted] = await Promise.all([loadBranchCommits(git, selected.request, this.branchMode), this.loadUncommitted(git, selected.repo, selected.request)]);
    if (generation !== this.branchGeneration) {
      return;
    }
    this.uncommitted = uncommitted;
    this.deps.logger.debug('branch commits loaded', {
      function: 'loadBranch',
      repo: selected.repo.name,
      revision: selected.request.revision,
      mode: this.branchMode,
      shown: list.shown,
      count: list.commits.length,
      durationMs: Date.now() - startedAt,
    });
    this.show(
      list.commits.map((commit) => ({ repo: selected.repo, root: selected.request.cwd, commit })),
      `${selected.request.label} · ${list.description}`,
      false,
      list.commits.length === 0 ? 'No commits.' : undefined,
      true,
    );
    await vscode.commands.executeCommand('setContext', 'gitComparePlus.commitsBranchMode', this.branchMode);
  }

  /** Show one commit's details, expanded (Show Commit Details from any commit list). */
  async showCommit(target: CommitTarget): Promise<void> {
    this.show([target], `commit ${commitTitle(target.commit)}`, true);
    await vscode.commands.executeCommand('gitComparePlus.commits.focus');
  }

  /** "Search Commits…": repo, then what to search by, then the text. */
  private async search(): Promise<void> {
    const repo = await this.deps.pickRepository();
    if (repo === undefined) {
      return;
    }
    const kind = await vscode.window.showQuickPick(
      // `searchKind`, not `kind`: QuickPickItem.kind already means separator vs item.
      SEARCH_KINDS.map((k) => ({ label: k.label, detail: k.detail, searchKind: k.kind, prompt: k.prompt })),
      { title: `Search commits in ${repo.name} by…` },
    );
    if (kind === undefined) {
      return;
    }
    const text = await vscode.window.showInputBox({
      title: `Search commits in ${repo.name}: ${kind.label.replace(/^\$\([^)]*\) /, '')}`,
      prompt: kind.prompt,
      validateInput: (value) => (value.trim() === '' ? 'Type something to search for' : undefined),
    });
    if (text === undefined) {
      return;
    }
    const query: CommitQuery = { kind: kind.searchKind, text: text.trim() };
    await vscode.commands.executeCommand('gitComparePlus.commits.focus');
    this.view.description = 'searching…';
    const found = await this.runSearch(repo, query);
    const shown = found.slice(0, SEARCH_LIMIT);
    this.show(
      shown.map((commit) => ({ repo, root: repo.root, commit })),
      `search: ${searchDescription(query, shown.length, found.length > SEARCH_LIMIT)}`,
      false,
      shown.length === 0 ? 'No commits matched.' : undefined,
    );
  }

  private async runSearch(repo: RepoInfo, query: CommitQuery): Promise<CommitEntry[]> {
    const git = await this.deps.getGit();
    const startedAt = Date.now();
    const args = searchArgs(query);
    const found = args === undefined ? [await git.commit(repo.root, query.text)].filter((c): c is CommitEntry => c !== undefined) : await git.searchCommits(repo.root, args, SEARCH_LIMIT + 1);
    this.deps.logger.info('commit search', { function: 'runSearch', repo: repo.name, query, count: found.length, durationMs: Date.now() - startedAt });
    return found;
  }

  /**
   * @param description - what the list is, shown next to the fixed "Commits" title. Names go here,
   *   not in the title: VS Code capitalises every word of a view title ("Fix/Etag-Weak").
   * @param isBranchList - true for a selected branch's commits (keeps the mode toggle).
   */
  private show(commits: readonly CommitTarget[], description: string | undefined, expandAll: boolean, emptyText?: string, isBranchList = false): void {
    // A search or a commit's details replaces a branch list: the mode toggle no longer applies.
    if (!isBranchList) {
      this.branch = undefined;
      this.uncommitted = undefined;
      void vscode.commands.executeCommand('setContext', 'gitComparePlus.commitsBranchMode', '');
    }
    this.commits = commits;
    this.expandAll = expandAll;
    this.emptyText = emptyText;
    this.view.description = description;
    this.changeEmitter.fire(undefined);
  }

  async getChildren(node?: CommitsNode): Promise<CommitsNode[]> {
    if (node === undefined) {
      const uncommittedRow: CommitsNode[] = this.uncommitted === undefined ? [] : [{ kind: 'uncommitted', result: this.uncommitted }];
      if (this.commits.length === 0) {
        // An empty list shows the view's welcome content (package.json viewsWelcome).
        return [...uncommittedRow, ...(this.emptyText === undefined ? [] : [{ kind: 'message' as const, text: this.emptyText }])];
      }
      return [...uncommittedRow, ...this.commits.map((target): CommitsNode => ({ kind: 'commit', target, expanded: this.expandAll }))];
    }
    if (node.kind === 'uncommitted') {
      return node.result.files.map((file) => ({ kind: 'uncommittedFile', result: node.result, file }));
    }
    if (node.kind !== 'commit') {
      return [];
    }
    try {
      return this.detailNodes(node.target, await this.loadDetails(node.target));
    } catch (error) {
      this.deps.logger.warn('commit details unavailable', { function: 'getChildren', sha: node.target.commit.sha, reason: error instanceof Error ? error.message : String(error) });
      return [{ kind: 'message', text: `Couldn't load this commit: ${error instanceof Error ? error.message : String(error)}` }];
    }
  }

  private detailNodes(target: CommitTarget, details: CommitDetails): CommitsNode[] {
    const { commit } = target;
    const when = new Date(commit.authoredAt).toISOString().slice(0, 16).replace('T', ' ');
    return [
      { kind: 'info', text: `${commit.author} · ${formatAge(commit.authoredAt, Date.now())}`, icon: 'person', tooltip: `${when} UTC` },
      ...details.parents.map((parent, i): CommitsNode => ({
        kind: 'parent',
        target: { ...target, commit: parent },
        label: `${details.parents.length > 1 ? `Parent ${i + 1}` : 'Parent'}: ${commitTitle(parent)}`,
      })),
      ...(details.files.length === 0 ? [{ kind: 'info' as const, text: 'No file changes', icon: 'info' }] : []),
      ...details.files.map((file): CommitsNode => ({ kind: 'file', target, file, parentRevision: details.parentRevision })),
    ];
  }

  private loadDetails(target: CommitTarget): Promise<CommitDetails> {
    const key = `${target.root}\0${target.commit.sha}`;
    let pending = this.details.get(key);
    if (pending === undefined) {
      pending = this.fetchDetails(target);
      pending.catch(() => this.details.delete(key));
      this.details.set(key, pending);
    }
    return pending;
  }

  private async fetchDetails(target: CommitTarget): Promise<CommitDetails> {
    const git = await this.deps.getGit();
    const { root, commit } = target;
    // Merges show what they brought in relative to their first parent, like the other views.
    const parentRevision = commit.parents[0] ?? (await git.emptyTree(root));
    const [files, numstat, message, parents] = await Promise.all([
      git.diffNameStatus(root, parentRevision, commit.sha),
      git.diffNumstat(root, parentRevision, commit.sha),
      git.commitMessage(root, commit.sha),
      Promise.all(commit.parents.map((sha) => git.commit(root, sha))),
    ]);
    return {
      parentRevision,
      message,
      parents: parents.filter((p): p is CommitEntry => p !== undefined),
      files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => {
        const lines = numstat.get(file.path);
        return lines === undefined ? file : { ...file, lines };
      }),
    };
  }

  getTreeItem(node: CommitsNode): vscode.TreeItem {
    switch (node.kind) {
      case 'commit':
        return this.commitItem(node);
      case 'info': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        return item;
      }
      case 'parent': {
        const item = new vscode.TreeItem(node.label);
        item.iconPath = new vscode.ThemeIcon('git-commit');
        item.tooltip = 'Click to show this commit';
        item.command = { command: 'gitComparePlus.commit.showDetails', title: 'Show Commit Details', arguments: [{ kind: 'commit', target: node.target, expanded: true }] };
        return item;
      }
      case 'file':
        return this.fileItem(node);
      case 'uncommitted':
        return uncommittedItem(node.result);
      case 'uncommittedFile':
        return this.uncommittedFileItem(node.result, node.file);
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  private commitItem(node: Extract<CommitsNode, { kind: 'commit' }>): vscode.TreeItem {
    const { commit } = node.target;
    const item = new vscode.TreeItem(commit.subject || commitTitle(commit), node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `commits:${node.target.root}:${commit.sha}:${node.expanded ? 'open' : 'closed'}`;
    item.description = commitDescription(commit, Date.now());
    item.iconPath = new vscode.ThemeIcon(commit.parents.length > 1 ? 'git-merge' : 'git-commit');
    item.contextValue = 'commitsCommit';
    // Placeholder; resolveTreeItem fills in the full message when the row is hovered.
    item.tooltip = `${commit.sha}\n${commit.author}\n\n${commit.subject}`;
    return item;
  }

  /** Hovering a commit row: show its full message (loads its details once). */
  async resolveTreeItem(item: vscode.TreeItem, node: CommitsNode): Promise<vscode.TreeItem> {
    if (node.kind !== 'commit') {
      return item;
    }
    try {
      const { message } = await this.loadDetails(node.target);
      item.tooltip = `${node.target.commit.sha}\n${node.target.commit.author}\n\n${message.trim()}`;
    } catch (error) {
      // The placeholder (subject) stays; getChildren reports the failure if the row is expanded.
      this.deps.logger.debug('commit message unavailable for tooltip', { function: 'resolveTreeItem', sha: node.target.commit.sha, reason: error instanceof Error ? error.message : String(error) });
    }
    return item;
  }

  private fileItem(node: Extract<CommitsNode, { kind: 'file' }>): vscode.TreeItem {
    const { file } = node;
    const item = new vscode.TreeItem(path.posix.basename(file.path));
    item.resourceUri = changedFileUri(file, node.target.repo.commonDir);
    const icon = diffBarIcon(file, this.deps.extensionUri);
    if (icon !== undefined) {
      item.iconPath = icon;
    }
    const directory = path.posix.dirname(file.path);
    const where = file.status === 'renamed' ? `${directory === '.' ? '' : directory} ← ${file.oldPath}`.trim() : directory === '.' ? '' : directory;
    item.description = [fileLineStatsText(file.lines), where].filter((part) => part.length > 0).join('  ');
    item.tooltip = file.path;
    item.contextValue = 'commitsFile';
    item.command = { command: 'gitComparePlus.commits.openFile', title: 'Open Change', arguments: [node] };
    return item;
  }

  private uncommittedFileItem(result: ComparisonResult, file: ChangedFile): vscode.TreeItem {
    const item = new vscode.TreeItem(path.posix.basename(file.path));
    item.resourceUri = changedFileUri(file, result.repo.commonDir);
    const icon = diffBarIcon(file, this.deps.extensionUri);
    if (icon !== undefined) {
      item.iconPath = icon;
    }
    const directory = path.posix.dirname(file.path);
    item.description = [fileLineStatsText(file.lines), directory === '.' ? '' : directory].filter((part) => part.length > 0).join('  ');
    item.tooltip = `${file.path}\nNot committed yet. Click to compare with the last commit.`;
    item.contextValue = 'uncommittedFile';
    item.command = { command: 'gitComparePlus.commits.openUncommittedFile', title: 'Open Change', arguments: [{ kind: 'uncommittedFile', result, file }] };
    return item;
  }

  // The file at the worktree's last commit vs as it is on disk (editable).
  private async openUncommittedFile(node: CommitsNode | undefined): Promise<void> {
    if (node?.kind !== 'uncommittedFile') {
      return;
    }
    const sides = diffSides(node.result, node.file);
    await vscode.commands.executeCommand('vscode.diff', sideToUri(sides.left, node.file.oldPath), sideToUri(sides.right, node.file.path), `${path.posix.basename(node.file.path)} (last commit ↔ working tree)`);
  }

  /** The Uncommitted changes row's Review: those changes in Changes, against the last commit. */
  private async reviewUncommitted(node: CommitsNode | undefined): Promise<void> {
    if (node?.kind !== 'uncommitted' || node.result.subject.kind !== 'worktree') {
      return;
    }
    await this.deps.review({ requests: [{ repo: node.result.repo, subject: node.result.subject }], base: LAST_COMMIT, mode: 'direct' });
  }

  // The file before (first parent) and after the commit.
  private async openFile(node: CommitsNode | undefined): Promise<void> {
    if (node?.kind !== 'file') {
      return;
    }
    const { target, file } = node;
    const result: ComparisonResult = {
      repo: { ...target.repo, root: target.root },
      subject: { kind: 'ref', ref: target.commit.sha, label: commitTitle(target.commit), refKind: 'commit' },
      outcome: 'compared',
      mode: 'direct',
      baseRevision: node.parentRevision,
      subjectRevision: target.commit.sha,
      excludedUncommitted: {},
      files: [file],
    };
    const sides = diffSides(result, file);
    await vscode.commands.executeCommand(
      'vscode.diff',
      sideToUri(sides.left, file.oldPath),
      sideToUri(sides.right, file.path),
      `${path.posix.basename(file.path)} (${target.commit.sha.slice(0, 7)}^ ↔ ${target.commit.sha.slice(0, 7)})`,
    );
  }

  private async guard(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.deps.logger.error('commits view action failed', error, { function: name });
      this.view.description = undefined;
      void vscode.window.showErrorMessage(`Git Compare+: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

// "Against: last commit": HEAD, resolved in the reviewed worktree (comparison.ts runs git there).
const LAST_COMMIT: BaseSpec = { kind: 'ref', ref: 'HEAD', label: 'last commit', refKind: 'commit' };

function uncommittedSubject(worktree: { readonly root: string; readonly label: string }): Subject {
  return { kind: 'worktree', root: worktree.root, label: worktree.label, includeUncommitted: true };
}

function uncommittedItem(result: ComparisonResult): vscode.TreeItem {
  const count = result.files.length;
  const item = new vscode.TreeItem('Uncommitted changes', vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `uncommitted:${result.subject.kind === 'worktree' ? result.subject.root : result.repo.root}`;
  item.description = `${count} file${count === 1 ? '' : 's'} · not committed yet`;
  item.tooltip = 'What is on disk in this worktree but not committed, against its last commit. Review opens it in Changes.';
  item.iconPath = new vscode.ThemeIcon('edit');
  item.contextValue = 'uncommittedGroup';
  return item;
}
