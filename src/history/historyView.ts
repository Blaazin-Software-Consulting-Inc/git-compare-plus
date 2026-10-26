/**
 * historyView — the "History" view (file and line history) and the editor-title ◀ ▶ buttons that
 * step through a file's versions. Logic lives in historyModel.ts; this module is the VS Code side.
 *
 * Hidden until asked for: Show File History (editor, Explorer, Changes, Commits and stash file
 * rows) or Show Line History (a selection) sets `gitComparePlus.historyShown`, which makes the view
 * appear; its ✕ hides it again, and it starts hidden after every reload. It stays on the file you
 * asked for: switching editors does not change it, and asking for another file replaces it.
 *
 * Every commit row offers the same comparisons:
 *   click                     the file just before vs at that commit
 *   Compare with Working Tree the file at that commit vs as it is now (editable)
 *   Compare with Branch…      the file at that commit vs any branch, tag, commit or worktree
 *   Select for Compare, then Compare with Selected; or select two rows → Compare These Two
 *
 * plus the whole-commit actions every commit list shares (commits/commitActions.ts): Show Commit
 * Details, Open Commit, Review This Commit, Review Changes Since, Copy Commit ID, …
 *
 * Cost: one `git log --follow` (or `-L`) when you ask; the ◀ ▶ buttons load a file's history on
 * first use. Both are cached and cleared on any git change, which also reloads what is shown.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BaseSpec, RepoInfo } from '../comparison';
import type { GitCli } from '../git/gitCli';
import type { Logger } from '../logger';
import type { CommitsNode } from '../commits/commitsView';
import type { ChangesNode } from '../views/changesView';
import type { RepoTreeNode } from '../views/repositoriesView';
import { commitDescription, commitTitle, commitTooltip } from '../views/commitText';
import { parseRevisionUri, revisionUri, sideToUri } from '../views/content';
import { HISTORY_LIMIT, historyDescription, previousVersion, step, type FileVersion, type HistoryEntry, type HistoryPosition, type HistoryState } from './historyModel';

/** Collaborators from extension.ts. */
export interface HistoryDeps {
  getGit(): Promise<GitCli>;
  /** The repo a worktree root belongs to (for pickers and the Changes view). */
  repoFor(root: string): Promise<RepoInfo | undefined>;
  /** The grouped "Compare it with…" picker. */
  pickAgainst(repo: RepoInfo, title: string): Promise<BaseSpec | undefined>;
  readonly logger: Logger;
}

/** Tree nodes. `root` (the worktree) lets the shared commit actions act on an entry. */
export type HistoryNode =
  | { readonly kind: 'entry'; readonly index: number; readonly entry: HistoryEntry; readonly root: string }
  | { readonly kind: 'message'; readonly text: string; readonly icon: string };

/** Tree data for the History view. */
class HistoryProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  state: HistoryState | undefined;
  message: string | undefined = 'Open a file to see its history.';

  show(state: HistoryState | undefined, message?: string): void {
    this.state = state;
    this.message = message;
    this.changeEmitter.fire();
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    if (node !== undefined) {
      return [];
    }
    if (this.state === undefined) {
      return this.message === undefined ? [] : [{ kind: 'message', text: this.message, icon: 'info' }];
    }
    if (this.state.entries.length === 0) {
      return [{ kind: 'message', text: 'No commits have changed this yet.', icon: 'info' }];
    }
    const { root } = this.state;
    return this.state.entries.map((entry, index) => ({ kind: 'entry', index, entry, root }));
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }
    const { entry } = node;
    const item = new vscode.TreeItem(entry.commit.subject || commitTitle(entry.commit), vscode.TreeItemCollapsibleState.None);
    item.id = `history:${entry.commit.sha}`;
    const renamed = this.state !== undefined && entry.path !== this.state.path ? ` · as ${entry.path}` : '';
    item.description = `${commitDescription(entry.commit, Date.now())}${renamed}`;
    item.tooltip = `${commitTooltip(entry.commit).replace(/\n\n.*$/s, '')}\n\nClick to see what this commit changed in the file.`;
    item.iconPath = new vscode.ThemeIcon(entry.commit.parents.length > 1 ? 'git-merge' : 'git-commit');
    item.contextValue = 'historyCommit';
    item.command = { command: 'gitComparePlus.history.openDiff', title: 'Compare with Previous', arguments: [node] };
    return item;
  }
}

/** The History view, its commands, and the ◀ ▶ editor buttons. */
export class HistoryController implements vscode.Disposable {
  private readonly provider = new HistoryProvider();
  private readonly view: vscode.TreeView<HistoryNode>;
  private readonly subscriptions: vscode.Disposable[];
  // Worktree root per folder (one `rev-parse --show-toplevel` per folder).
  private readonly roots = new Map<string, Promise<string | undefined>>();
  // File histories for ◀ ▶, by `<root>\0<path>`; cleared on git changes.
  private readonly histories = new Map<string, Promise<HistoryState>>();
  private selected: { readonly root: string; readonly entry: HistoryEntry; readonly pathToday: string } | undefined;
  private stale = false;

  constructor(private readonly deps: HistoryDeps) {
    this.view = vscode.window.createTreeView('gitComparePlus.history', { treeDataProvider: this.provider, canSelectMany: true });
    this.subscriptions = [
      this.view,
      // A git change while the view was collapsed: catch up when it is expanded again.
      this.view.onDidChangeVisibility((event) => {
        const state = this.provider.state;
        if (event.visible && this.stale && state !== undefined) {
          void this.load(state.mode, state.root, state.path, state.lines);
        }
      }),
      // Only for the ◀ ▶ buttons; the view itself stays on the file that was asked for.
      vscode.window.onDidChangeActiveTextEditor(() => void this.updateEditorContext()),
      ...this.registerCommands(),
    ];
    void this.updateEditorContext();
  }

  /** A git change: cached histories are out of date; reload what is on screen. */
  gitChanged(): void {
    this.histories.clear();
    const state = this.provider.state;
    if (state === undefined) {
      return;
    }
    if (!this.view.visible) {
      this.stale = true;
      return;
    }
    void this.load(state.mode, state.root, state.path, state.lines);
  }

  private async load(mode: 'file' | 'lines', root: string, filePath: string, lines?: { start: number; end: number }): Promise<void> {
    this.stale = false;
    this.view.description = 'loading…';
    try {
      const state = mode === 'file' ? await this.fileHistory(root, filePath) : await this.lineHistory(root, filePath, lines ?? { start: 1, end: 1 });
      this.provider.show(state);
      // The file goes in the description: VS Code capitalises every word of a view title.
      this.view.description = `${path.posix.basename(filePath)} · ${historyDescription(state)}`;
      this.view.message = state.truncated ? `Showing the newest ${HISTORY_LIMIT} commits.` : undefined;
    } catch (error) {
      this.deps.logger.warn('history unavailable', { function: 'load', mode, root, path: filePath, lines, reason: error instanceof Error ? error.message : String(error) });
      this.provider.show(undefined, `Couldn't load the history: ${error instanceof Error ? error.message : String(error)}`);
      this.view.description = undefined;
    }
  }

  private fileHistory(root: string, filePath: string): Promise<HistoryState> {
    const key = `${root}\0${filePath}`;
    let pending = this.histories.get(key);
    if (pending === undefined) {
      pending = this.deps.getGit().then(async (git) => {
        const found = await git.fileHistory(root, filePath, HISTORY_LIMIT + 1);
        this.deps.logger.debug('file history loaded', { function: 'fileHistory', root, path: filePath, count: found.length });
        return {
          mode: 'file' as const,
          root,
          path: filePath,
          entries: found.slice(0, HISTORY_LIMIT).map((e) => ({ commit: e.commit, path: e.path, status: e.status })),
          truncated: found.length > HISTORY_LIMIT,
        };
      });
      pending.catch(() => this.histories.delete(key));
      this.histories.set(key, pending);
    }
    return pending;
  }

  private async lineHistory(root: string, filePath: string, lines: { start: number; end: number }): Promise<HistoryState> {
    const found = await (await this.deps.getGit()).lineHistory(root, filePath, lines.start, lines.end, HISTORY_LIMIT + 1);
    this.deps.logger.debug('line history loaded', { function: 'lineHistory', root, path: filePath, lines, count: found.length });
    return {
      mode: 'lines',
      root,
      path: filePath,
      lines,
      entries: found.slice(0, HISTORY_LIMIT).map((commit) => ({ commit, path: filePath, status: 'M' })),
      truncated: found.length > HISTORY_LIMIT,
    };
  }

  /** Worktree root and repo-relative path of a file or revision document; undefined otherwise. */
  private async fileOf(uri: vscode.Uri | undefined): Promise<{ root: string; path: string } | undefined> {
    if (uri === undefined) {
      return undefined;
    }
    const revision = parseRevisionUri(uri);
    if (revision !== undefined) {
      return { root: revision.cwd, path: revision.pathToday };
    }
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const root = await this.rootFor(path.dirname(uri.fsPath));
    return root === undefined ? undefined : { root, path: path.relative(root, uri.fsPath).split(path.sep).join('/') };
  }

  private rootFor(directory: string): Promise<string | undefined> {
    let pending = this.roots.get(directory);
    if (pending === undefined) {
      pending = this.deps.getGit().then((git) => git.toplevel(directory));
      pending.catch(() => this.roots.delete(directory));
      this.roots.set(directory, pending);
    }
    return pending;
  }

  // Shows the ◀ ▶ editor buttons only for files in a git worktree (and our revision documents).
  private async updateEditorContext(): Promise<void> {
    let inGit = false;
    try {
      inGit = (await this.fileOf(vscode.window.activeTextEditor?.document.uri)) !== undefined;
    } catch (error) {
      this.deps.logger.debug('could not tell whether the active file is in git', { function: 'updateEditorContext', reason: error instanceof Error ? error.message : String(error) });
    }
    await vscode.commands.executeCommand('setContext', 'gitComparePlus.activeFileInGit', inGit);
  }

  // --- comparisons -------------------------------------------------------------------------

  private versionUri(state: HistoryState, version: FileVersion): vscode.Uri {
    return version.kind === 'empty' ? sideToUri({ kind: 'empty' }, state.path) : revisionUri(state.root, version.sha, version.path, state.path);
  }

  private entryUri(state: HistoryState, entry: HistoryEntry): vscode.Uri {
    return revisionUri(state.root, entry.commit.sha, entry.path, state.path);
  }

  private workingUri(state: Pick<HistoryState, 'root' | 'path'>): vscode.Uri {
    return vscode.Uri.file(path.join(state.root, state.path));
  }

  private async diff(left: vscode.Uri, right: vscode.Uri, filePath: string, leftLabel: string, rightLabel: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(filePath)} (${leftLabel} ↔ ${rightLabel})`);
  }

  private async openDiff(node: HistoryNode | undefined): Promise<void> {
    const state = this.provider.state;
    if (node?.kind !== 'entry' || state === undefined) {
      return;
    }
    const before = previousVersion(state, node.index);
    await this.diff(this.versionUri(state, before), this.entryUri(state, node.entry), state.path, before.kind === 'empty' ? 'new file' : before.sha.slice(0, 7), short(node.entry));
  }

  private async compareWithWorkingTree(node: HistoryNode | undefined): Promise<void> {
    const state = this.provider.state;
    if (node?.kind !== 'entry' || state === undefined) {
      return;
    }
    await this.diff(this.entryUri(state, node.entry), this.workingUri(state), state.path, short(node.entry), 'working tree');
  }

  // The file at this commit (right) against the file in any branch, tag, commit or worktree (left).
  private async compareWithBranch(node: HistoryNode | undefined): Promise<void> {
    const state = this.provider.state;
    if (node?.kind !== 'entry' || state === undefined) {
      return;
    }
    const repo = await this.deps.repoFor(state.root);
    if (repo === undefined) {
      return;
    }
    const base = await this.deps.pickAgainst(repo, `Compare ${path.posix.basename(state.path)} at ${short(node.entry)} with…`);
    if (base === undefined) {
      return;
    }
    const git = await this.deps.getGit();
    let left: vscode.Uri;
    let leftLabel: string;
    if (base.kind === 'worktree') {
      // A worktree side is that worktree's file: on disk with uncommitted edits, else its HEAD.
      left = base.includeUncommitted ? this.workingUri({ root: base.root, path: state.path }) : revisionUri(base.root, 'HEAD', state.path, state.path);
      leftLabel = base.label;
    } else {
      const ref = base.kind === 'default' ? await git.defaultBranch(state.root) : base.ref;
      if (ref === undefined) {
        void vscode.window.showInformationMessage("This repository's default branch wasn't found.");
        return;
      }
      left = revisionUri(state.root, ref, state.path, state.path);
      leftLabel = base.kind === 'ref' ? (base.label ?? ref) : ref;
    }
    await this.diff(left, this.entryUri(state, node.entry), state.path, leftLabel, short(node.entry));
  }

  private async selectForCompare(node: HistoryNode | undefined): Promise<void> {
    const state = this.provider.state;
    if (node?.kind !== 'entry' || state === undefined) {
      return;
    }
    this.selected = { root: state.root, entry: node.entry, pathToday: state.path };
    await vscode.commands.executeCommand('setContext', 'gitComparePlus.historySelected', true);
    vscode.window.setStatusBarMessage(`Selected ${short(node.entry)} for compare: right-click another commit → Compare with Selected`, 5000);
  }

  // The selected commit on the left, this one on the right; same file (paths at each commit).
  private async compareWithSelected(node: HistoryNode | undefined): Promise<void> {
    const state = this.provider.state;
    const selected = this.selected;
    if (node?.kind !== 'entry' || state === undefined || selected === undefined) {
      return;
    }
    const left = revisionUri(selected.root, selected.entry.commit.sha, selected.entry.path, selected.pathToday);
    await this.diff(left, this.entryUri(state, node.entry), state.path, short(selected.entry), short(node.entry));
  }

  // Two rows selected: the older one on the left (rows are newest first).
  private async compareTwo(node: HistoryNode | undefined, selection: readonly HistoryNode[] | undefined): Promise<void> {
    const state = this.provider.state;
    const picked = (selection ?? (node !== undefined ? [node] : [])).filter((n): n is Extract<HistoryNode, { kind: 'entry' }> => n.kind === 'entry');
    if (state === undefined || picked.length !== 2) {
      void vscode.window.showInformationMessage('Select exactly two commits (Cmd/Ctrl-click) to compare them.');
      return;
    }
    const [newer, older] = [...picked].sort((a, b) => a.index - b.index);
    if (newer === undefined || older === undefined) {
      return;
    }
    await this.diff(this.entryUri(state, older.entry), this.entryUri(state, newer.entry), state.path, short(older.entry), short(newer.entry));
  }

  // --- show history ------------------------------------------------------------------------

  /**
   * Show File History for a file: from the editor or Explorer (a URI), from a changed-file row in
   * Changes, Commits or a stash, or the active editor when called from the Command Palette.
   */
  private async showFileHistory(arg: unknown): Promise<void> {
    const file = fileFromRow(arg) ?? (await this.fileOf(arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri));
    if (file === undefined) {
      void vscode.window.showInformationMessage('Open a file in a git repository to see its history.');
      return;
    }
    await this.reveal();
    await this.load('file', file.root, file.path);
  }

  // Makes the view appear (it is hidden until asked for), then focuses it.
  private async reveal(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'gitComparePlus.historyShown', true);
    await vscode.commands.executeCommand('gitComparePlus.history.focus');
  }

  /** ✕ in the view's title bar: hide the view and forget what it showed. */
  private async close(): Promise<void> {
    this.provider.show(undefined);
    this.stale = false;
    await vscode.commands.executeCommand('setContext', 'gitComparePlus.historyShown', false);
  }

  private async showLineHistory(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const file = await this.fileOf(editor?.document.uri);
    if (editor === undefined || file === undefined) {
      void vscode.window.showInformationMessage('Select lines in a file in a git repository to see their history.');
      return;
    }
    const { start, end } = editor.selection;
    // A selection ending at column 0 of a line does not include that line.
    const lastLine = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
    await this.reveal();
    await this.load('lines', file.root, file.path, { start: start.line + 1, end: lastLine + 1 });
  }

  // --- ◀ ▶ through versions ------------------------------------------------------------------

  private async stepRevision(direction: 'previous' | 'next'): Promise<void> {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const inDiff = tab?.input instanceof vscode.TabInputTextDiff;
    const rightUri = tab?.input instanceof vscode.TabInputTextDiff ? tab.input.modified : vscode.window.activeTextEditor?.document.uri;
    const file = await this.fileOf(rightUri);
    if (rightUri === undefined || file === undefined) {
      return;
    }
    const history = await this.fileHistory(file.root, file.path);
    const revision = parseRevisionUri(rightUri);
    let position: HistoryPosition;
    if (revision === undefined) {
      const uncommitted = !inDiff && (await (await this.deps.getGit()).hasUncommittedChanges(file.root, file.path));
      position = { kind: 'working', inDiff, uncommitted };
    } else {
      const index = history.entries.findIndex((e) => e.commit.sha === revision.revision || e.commit.sha.startsWith(revision.revision));
      if (index < 0) {
        void vscode.window.showInformationMessage("This version isn't one of the file's commits. Open the History view to pick a version.");
        return;
      }
      position = { kind: 'commit', index };
    }
    const result = step(position, direction, history.entries.length);
    if (result.kind === 'message') {
      vscode.window.setStatusBarMessage(result.text, 4000);
      return;
    }
    if (result.right === 'working') {
      const newest = history.entries[0];
      if (newest !== undefined) {
        await this.diff(this.entryUri(history, newest), this.workingUri(history), history.path, short(newest), 'working tree');
      }
      return;
    }
    const entry = history.entries[result.right];
    if (entry === undefined) {
      return;
    }
    const before = previousVersion(history, result.right);
    await this.diff(this.versionUri(history, before), this.entryUri(history, entry), history.path, before.kind === 'empty' ? 'new file' : before.sha.slice(0, 7), short(entry));
  }

  private registerCommands(): vscode.Disposable[] {
    const guarded = <A extends unknown[]>(id: string, run: (...args: A) => Promise<void>) =>
      vscode.commands.registerCommand(id, async (...args: A) => {
        try {
          await run(...args);
        } catch (error) {
          this.deps.logger.error('history action failed', error, { function: 'registerCommands', command: id });
          void vscode.window.showErrorMessage(`Git Compare+: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return [
      guarded('gitComparePlus.history.showFile', (arg?: unknown) => this.showFileHistory(arg)),
      guarded('gitComparePlus.history.close', () => this.close()),
      guarded('gitComparePlus.history.showLines', () => this.showLineHistory()),
      guarded('gitComparePlus.history.openDiff', (node?: HistoryNode) => this.openDiff(node)),
      guarded('gitComparePlus.history.compareWithWorkingTree', (node?: HistoryNode) => this.compareWithWorkingTree(node)),
      guarded('gitComparePlus.history.compareWithBranch', (node?: HistoryNode) => this.compareWithBranch(node)),
      guarded('gitComparePlus.history.selectForCompare', (node?: HistoryNode) => this.selectForCompare(node)),
      guarded('gitComparePlus.history.compareWithSelected', (node?: HistoryNode) => this.compareWithSelected(node)),
      guarded('gitComparePlus.history.compareTwo', (node?: HistoryNode, selection?: HistoryNode[]) => this.compareTwo(node, selection)),
      guarded('gitComparePlus.previousRevision', () => this.stepRevision('previous')),
      guarded('gitComparePlus.nextRevision', () => this.stepRevision('next')),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }
}

/**
 * The file a changed-file row stands for, as worktree root + repo-relative path: a file in Changes
 * (read in the reviewed worktree, or the repo for a branch), in a commit in the Commits view, or
 * in a stash. Undefined for anything else (URIs are handled by `fileOf`).
 */
function fileFromRow(arg: unknown): { root: string; path: string } | undefined {
  if (isChangesFile(arg) || isUncommittedFile(arg)) {
    return { root: arg.result.subject.kind === 'worktree' ? arg.result.subject.root : arg.result.repo.root, path: arg.file.path };
  }
  if (isCommitsFile(arg)) {
    return { root: arg.target.root, path: arg.file.path };
  }
  if (isStashFile(arg)) {
    return { root: arg.repo.root, path: arg.entry.file.path };
  }
  return undefined;
}

// Menu arguments arrive untyped; these check which view's row it is.
function isChangesFile(arg: unknown): arg is Extract<ChangesNode, { kind: 'file' }> {
  return typeof arg === 'object' && arg !== null && 'kind' in arg && arg.kind === 'file' && 'result' in arg && 'file' in arg;
}

function isUncommittedFile(arg: unknown): arg is Extract<CommitsNode, { kind: 'uncommittedFile' }> {
  return typeof arg === 'object' && arg !== null && 'kind' in arg && arg.kind === 'uncommittedFile' && 'result' in arg && 'file' in arg;
}

function isCommitsFile(arg: unknown): arg is Extract<CommitsNode, { kind: 'file' }> {
  return typeof arg === 'object' && arg !== null && 'kind' in arg && arg.kind === 'file' && 'target' in arg && 'file' in arg;
}

function isStashFile(arg: unknown): arg is Extract<RepoTreeNode, { kind: 'stashFile' }> {
  return typeof arg === 'object' && arg !== null && 'kind' in arg && arg.kind === 'stashFile' && 'entry' in arg && 'repo' in arg;
}

function short(entry: HistoryEntry): string {
  return entry.commit.sha.slice(0, 7);
}
