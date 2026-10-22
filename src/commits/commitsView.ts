/**
 * commitsView — the "Commits" view: search results, and the details of any commit opened from
 * elsewhere (Show Commit Details on the Commits group in Changes, the History view, or here).
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
import { diffSides, type ComparisonResult, type RepoInfo } from '../comparison';
import type { GitCli } from '../git/gitCli';
import type { ChangedFile, CommitEntry } from '../git/parsers';
import type { Logger } from '../logger';
import { formatAge } from '../operations';
import { commitDescription, commitTitle } from '../views/commitText';
import { sideToUri } from '../views/content';
import { changedFileUri, diffBarIcon } from '../views/changesView';
import { fileLineStatsText } from '../views/lineStatsText';
import { SEARCH_KINDS, SEARCH_LIMIT, searchArgs, searchDescription, type CommitQuery } from './commitSearch';
import type { CommitTarget } from './commitTarget';

/** Collaborators from extension.ts. */
export interface CommitsViewDeps {
  getGit(): Promise<GitCli>;
  /** Which repo to search in (skipped when there is one). */
  pickRepository(): Promise<RepoInfo | undefined>;
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
}

/** Tree nodes. `commit` nodes are what the shared commit actions (commitActions.ts) act on. */
export type CommitsNode =
  | { readonly kind: 'commit'; readonly target: CommitTarget; readonly expanded: boolean }
  | { readonly kind: 'info'; readonly text: string; readonly icon: string; readonly tooltip?: string }
  | { readonly kind: 'parent'; readonly target: CommitTarget; readonly label: string }
  | { readonly kind: 'file'; readonly target: CommitTarget; readonly file: ChangedFile; readonly parentRevision: string }
  | { readonly kind: 'message'; readonly text: string };

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

  constructor(private readonly deps: CommitsViewDeps) {
    this.view = vscode.window.createTreeView('branchCompare.commits', { treeDataProvider: this, canSelectMany: true, showCollapseAll: true });
    this.subscriptions = [
      this.view,
      vscode.commands.registerCommand('branchCompare.commits.search', () => this.guard('search', () => this.search())),
      vscode.commands.registerCommand('branchCompare.commits.openFile', (node?: CommitsNode) => this.guard('openFile', () => this.openFile(node))),
      vscode.commands.registerCommand('branchCompare.commits.clear', () => this.show([], undefined, undefined, false)),
    ];
  }

  /** Show one commit's details, expanded (Show Commit Details from any commit list). */
  async showCommit(target: CommitTarget): Promise<void> {
    this.show([target], `Commit ${target.commit.sha.slice(0, 7)}`, commitTitle(target.commit), true);
    await vscode.commands.executeCommand('branchCompare.commits.focus');
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
    await vscode.commands.executeCommand('branchCompare.commits.focus');
    this.view.description = 'searching…';
    const found = await this.runSearch(repo, query);
    const shown = found.slice(0, SEARCH_LIMIT);
    this.show(
      shown.map((commit) => ({ repo, root: repo.root, commit })),
      'Search results',
      searchDescription(query, shown.length, found.length > SEARCH_LIMIT),
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

  private show(commits: readonly CommitTarget[], title: string | undefined, description: string | undefined, expandAll: boolean, emptyText?: string): void {
    this.commits = commits;
    this.expandAll = expandAll;
    this.emptyText = emptyText;
    this.view.title = title ?? 'Commits';
    this.view.description = description;
    this.changeEmitter.fire(undefined);
  }

  async getChildren(node?: CommitsNode): Promise<CommitsNode[]> {
    if (node === undefined) {
      if (this.commits.length === 0) {
        // An empty list shows the view's welcome content (package.json viewsWelcome).
        return this.emptyText === undefined ? [] : [{ kind: 'message', text: this.emptyText }];
      }
      return this.commits.map((target) => ({ kind: 'commit', target, expanded: this.expandAll }));
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
        item.command = { command: 'branchCompare.commit.showDetails', title: 'Show Commit Details', arguments: [{ kind: 'commit', target: node.target, expanded: true }] };
        return item;
      }
      case 'file':
        return this.fileItem(node);
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
    item.command = { command: 'branchCompare.commits.openFile', title: 'Open Change', arguments: [node] };
    return item;
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
      void vscode.window.showErrorMessage(`Git Branch & Worktree Compare: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}
