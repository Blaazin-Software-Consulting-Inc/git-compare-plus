/**
 * changesView — the "Changes" tree: files changed by the current comparison.
 *
 * Shape:
 *   - One comparison (one repo): files at the root; the view description says what was compared.
 *   - Several (e.g. "Compare all repos"): a node per repo that has changes, skipped, or failed;
 *     repos with no changes are left out and counted in the view message.
 *
 * A collapsed "Commits" group (one per repo) lists the commits the comparison covers, newest first;
 * clicking one opens that commit's own changes in a multi-file diff without leaving the
 * comparison (`gitComparePlus.openCommit`). Not shown when there are none, or the base is a snapshot.
 *
 * Layout (setting `gitComparePlus.changesLayout`, toggled from the title bar): `list` shows files
 * flat with their folder as the description; `tree` groups them into compacted folders
 * (fileTree.ts), each with its own +/− totals.
 *
 * Clicking a file runs `gitComparePlus.openChange`, which opens the diff editor (extension.ts).
 * Each file has a "reviewed" checkbox. Its state is read from the ReviewStore on every render
 * (via `isReviewed`), keyed by the file's diff fingerprint, so a mark disappears by itself when an
 * automatic refresh brings a changed version of the file. Toggles are handled in extension.ts.
 * The row's icon is a green/red diff bar for its line counts (diffBar.ts) instead of the file-type
 * icon; binary files and files with unknown counts keep the file-type icon. The hover repeats the
 * counts in colour, since the row's description text cannot be coloured. A file with uncommitted
 * edits starts its description with `✎` (changeOrigin.ts); the hover says committed / uncommitted
 * / both, and which kind of uncommitted edit.
 * Status letters and colors come from a FileDecorationProvider on the private
 * `git-compare-plus-item:` scheme. Using real file URIs as `resourceUri` would make the editor's own git
 * decorations (relative to HEAD, not to the comparison base) appear and contradict ours.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { originMark, originTooltip, uncommittedFileCount } from '../changeOrigin';
import { hasBothOrigins, totalLineStats, type ComparisonResult } from '../comparison';
import type { ChangedFile, CommitEntry, FileStatus } from '../git/parsers';
import { commitCountText, commitDescription, commitTitle, commitTooltip } from './commitText';
import { describeHeader, sidesSummary, type BaseFetchInfo, type ComparisonSetup, type HeaderRow } from './changesHeader';
import { diffBarIconPath, diffBarShape, lineStatsHoverHtml } from './diffBar';
import { buildFileTree, filesUnder, type FolderNode } from './fileTree';
import { fileLineStatsText, lineStatsTooltip, totalLineStatsText } from './lineStatsText';

const ITEM_SCHEME = 'git-compare-plus-item';

/** The comparison on display: what was asked for (re-run on Refresh / header clicks) and its results. */
export interface ChangesState {
  readonly setup: ComparisonSetup;
  readonly results: readonly ComparisonResult[];
  /** Set when the base is a remote-tracking branch; drives the stale-fetch warning. */
  readonly baseFetch?: BaseFetchInfo;
}

/** Tree nodes. */
export type ChangesNode =
  | { readonly kind: 'header'; readonly row: HeaderRow }
  | { readonly kind: 'result'; readonly result: ComparisonResult }
  | { readonly kind: 'file'; readonly result: ComparisonResult; readonly file: ChangedFile }
  | { readonly kind: 'folder'; readonly result: ComparisonResult; readonly folder: FolderNode }
  | { readonly kind: 'commits'; readonly result: ComparisonResult }
  | { readonly kind: 'commit'; readonly result: ComparisonResult; readonly commit: CommitEntry }
  | { readonly kind: 'message'; readonly text: string; readonly icon: string };

const STATUS_DECORATION: Record<FileStatus, { badge: string; color: string; label: string }> = {
  added: { badge: 'A', color: 'gitDecoration.addedResourceForeground', label: 'Added' },
  untracked: { badge: 'U', color: 'gitDecoration.untrackedResourceForeground', label: 'Untracked' },
  modified: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground', label: 'Modified' },
  deleted: { badge: 'D', color: 'gitDecoration.deletedResourceForeground', label: 'Deleted' },
  renamed: { badge: 'R', color: 'gitDecoration.renamedResourceForeground', label: 'Renamed' },
};

/** How changed files are laid out: flat, or grouped into folders. */
export type ChangesLayout = 'list' | 'tree';

/** Tree data + decoration provider for the Changes view. */
export class ChangesProvider implements vscode.TreeDataProvider<ChangesNode>, vscode.FileDecorationProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly stateEmitter = new vscode.EventEmitter<ChangesState | undefined>();
  /** Fires when a comparison is shown, re-shown (refresh) or cleared; drives the folder watchers. */
  readonly onDidChangeState = this.stateEmitter.event;
  private state: ChangesState | undefined;
  private staleText: string | undefined;
  private view: vscode.TreeView<ChangesNode> | undefined;

  /**
   * @param isReviewed - whether this file's current diff is marked reviewed (ReviewStore).
   * @param extensionUri - extension root, to resolve the diff-bar icons under `media/`.
   * @param layout - reads the `gitComparePlus.changesLayout` setting; call `redraw` when it changes.
   */
  constructor(
    private readonly isReviewed: (result: ComparisonResult, file: ChangedFile) => boolean,
    private readonly extensionUri: vscode.Uri,
    private readonly layout: () => ChangesLayout,
  ) {}

  /** Re-render without a new comparison, e.g. after reviewed marks changed. */
  redraw(): void {
    this.updateViewChrome();
    this.changeEmitter.fire();
  }

  /** Attach the TreeView so description/message can be updated with the state. */
  attach(view: vscode.TreeView<ChangesNode>): void {
    this.view = view;
  }

  /** The comparison on display, if any. */
  current(): ChangesState | undefined {
    return this.state;
  }

  /** Show a new comparison. */
  show(state: ChangesState): void {
    this.state = state;
    this.updateViewChrome();
    void vscode.commands.executeCommand('setContext', 'gitComparePlus.hasComparison', true);
    // Drives "Open All Uncommitted Changes" in the title bar's … menu.
    void vscode.commands.executeCommand('setContext', 'gitComparePlus.hasUncommittedFiles', state.results.some((r) => uncommittedFileCount(r.files) > 0));
    this.changeEmitter.fire();
    this.stateEmitter.fire(state);
  }

  /** Back to the empty welcome state. */
  clear(): void {
    this.state = undefined;
    this.updateViewChrome();
    void vscode.commands.executeCommand('setContext', 'gitComparePlus.hasComparison', false);
    void vscode.commands.executeCommand('setContext', 'gitComparePlus.hasUncommittedFiles', false);
    this.changeEmitter.fire();
    this.stateEmitter.fire(undefined);
  }

  /** Every file node in display order; used by "Open All Changes". */
  allFileNodes(): Extract<ChangesNode, { kind: 'file' }>[] {
    return (this.state?.results ?? []).flatMap((result) => result.files.map((file) => ({ kind: 'file' as const, result, file })));
  }

  getChildren(node?: ChangesNode): ChangesNode[] {
    if (this.state === undefined) {
      // Empty list → the `viewsWelcome` content from package.json is shown.
      return [];
    }
    if (node?.kind === 'result') {
      return resultChildren(node.result, this.layout());
    }
    if (node?.kind === 'folder') {
      return folderChildren(node.result, node.folder);
    }
    if (node?.kind === 'commits') {
      return (node.result.commits?.entries ?? []).map((commit) => ({ kind: 'commit', result: node.result, commit }));
    }
    if (node !== undefined) {
      return [];
    }
    // The header rows always come first so what is being compared is never ambiguous.
    const header: ChangesNode[] = describeHeader(this.state.setup, this.state.results, this.state.baseFetch).map((row) => ({ kind: 'header', row }));
    return [...header, ...this.bodyNodes(this.state.results)];
  }

  private bodyNodes(results: readonly ComparisonResult[]): ChangesNode[] {
    if (results.length === 1 && results[0] !== undefined) {
      const only = results[0];
      if (only.outcome !== 'compared') {
        return [outcomeMessage(only)];
      }
      // Commits without file changes (e.g. reverted work) still deserve the Commits group.
      return only.files.length > 0 ? resultChildren(only, this.layout()) : [...commitsGroup(only), outcomeMessage(only)];
    }
    const shown = results.filter((r) => r.outcome !== 'compared' || r.files.length > 0);
    return shown.length > 0
      ? shown.map((result) => ({ kind: 'result', result }))
      : [{ kind: 'message', text: `No differences in ${results.length} repositories`, icon: 'check' }];
  }

  getTreeItem(node: ChangesNode): vscode.TreeItem {
    switch (node.kind) {
      case 'header':
        return headerItem(node.row);
      case 'result':
        return resultItem(node.result, this.reviewedCount(node.result));
      case 'folder':
        return folderItem(node.result, node.folder);
      case 'commits':
        return commitsGroupItem(node.result);
      case 'commit':
        return commitItem(node.result, node.commit);
      case 'file':
        return fileItem(node.result, node.file, this.isReviewed(node.result, node.file), this.extensionUri, this.layout() === 'list');
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ITEM_SCHEME) {
      return undefined;
    }
    const status = new URLSearchParams(uri.query).get('status');
    if (!isFileStatus(status)) {
      return undefined;
    }
    const decoration = STATUS_DECORATION[status];
    return new vscode.FileDecoration(decoration.badge, decoration.label, new vscode.ThemeColor(decoration.color));
  }

  private updateViewChrome(): void {
    if (this.view === undefined) {
      return;
    }
    const results = this.state?.results ?? [];
    const fileCount = results.reduce((total, r) => total + r.files.length, 0);
    const totals = totalLineStats(results.flatMap((r) => r.files));
    const reviewedCount = results.reduce((total, r) => total + this.reviewedCount(r), 0);
    this.view.description =
      this.state === undefined
        ? undefined
        : [
            // The sides first: with several sections stacked, the header says what this one shows.
            sidesSummary(this.state.setup, results),
            `${fileCount} file${fileCount === 1 ? '' : 's'}`,
            ...(reviewedCount > 0 ? [`${reviewedCount} reviewed`] : []),
            ...(fileCount > 0 ? [totalLineStatsText(totals)] : []),
          ].join(' · ');
    // A failing automatic refresh outranks the summary: the list below may be out of date.
    if (this.staleText !== undefined && this.state !== undefined) {
      this.view.message = this.staleText;
    } else if (results.length > 1) {
      const changed = results.filter((r) => r.files.length > 0).length;
      this.view.message = `${fileCount} files in ${changed} of ${results.length} repositories`;
    } else {
      this.view.message = undefined;
    }
  }

  private reviewedCount(result: ComparisonResult): number {
    return result.files.reduce((total, file) => total + (this.isReviewed(result, file) ? 1 : 0), 0);
  }

  /**
   * Show (or clear, with undefined) the "couldn't refresh, showing earlier results" message.
   * Set by ChangesAutoRefresh while a failure episode lasts.
   */
  setStaleMessage(text: string | undefined): void {
    this.staleText = text;
    this.updateViewChrome();
  }
}

function headerItem(row: HeaderRow): vscode.TreeItem {
  const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
  item.id = `header:${row.role}`;
  item.description = row.description;
  item.tooltip = row.tooltip;
  item.iconPath = new vscode.ThemeIcon(row.icon, row.warning ? new vscode.ThemeColor('list.warningForeground') : undefined);
  item.contextValue = `header.${row.role}`;
  if (row.command !== undefined) {
    item.command = { command: row.command, title: row.label };
  }
  return item;
}

function isFileStatus(value: string | null): value is FileStatus {
  return value !== null && Object.hasOwn(STATUS_DECORATION, value);
}

function fileNodes(result: ComparisonResult): ChangesNode[] {
  return result.files.map((file) => ({ kind: 'file', result, file }));
}

// Commits first: they are short (collapsed) and say what the file list is made of.
function resultChildren(result: ComparisonResult, layout: ChangesLayout): ChangesNode[] {
  return [...commitsGroup(result), ...(layout === 'tree' ? folderChildren(result, buildFileTree(result.files)) : fileNodes(result))];
}

function folderChildren(result: ComparisonResult, folder: FolderNode): ChangesNode[] {
  return [
    ...folder.folders.map((child): ChangesNode => ({ kind: 'folder', result, folder: child })),
    ...folder.files.map((file): ChangesNode => ({ kind: 'file', result, file })),
  ];
}

function folderItem(result: ComparisonResult, folder: FolderNode): vscode.TreeItem {
  const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `folder:${result.repo.commonDir}:${subjectKey(result)}:${folder.path}`;
  // ThemeIcon.Folder + a resourceUri gives the file icon theme's folder icon for this name.
  item.iconPath = vscode.ThemeIcon.Folder;
  item.resourceUri = vscode.Uri.from({ scheme: ITEM_SCHEME, path: `/${folder.path}` });
  const files = filesUnder(folder);
  item.description = `${files.length} · ${totalLineStatsText(totalLineStats(files))}`;
  item.tooltip = `${folder.path}/\n${files.length} changed file${files.length === 1 ? '' : 's'}`;
  return item;
}

function commitsGroup(result: ComparisonResult): ChangesNode[] {
  return (result.commits?.entries.length ?? 0) > 0 ? [{ kind: 'commits', result }] : [];
}

function commitsGroupItem(result: ComparisonResult): vscode.TreeItem {
  const commits = result.commits ?? { entries: [], truncated: false };
  const item = new vscode.TreeItem('Commits', vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `commits:${result.repo.commonDir}:${subjectKey(result)}`;
  item.description = commitCountText(commits);
  item.iconPath = new vscode.ThemeIcon('git-commit');
  item.tooltip = commits.truncated
    ? `The newest ${commits.entries.length} of more commits in ${result.subject.label} that ${result.baseLabel ?? 'the base'} does not have.`
    : `Commits in ${result.subject.label} that ${result.baseLabel ?? 'the base'} does not have. Uncommitted edits are not commits and are not listed.`;
  return item;
}

function commitItem(result: ComparisonResult, commit: CommitEntry): vscode.TreeItem {
  const item = new vscode.TreeItem(commit.subject || commitTitle(commit), vscode.TreeItemCollapsibleState.None);
  item.id = `commit:${result.repo.commonDir}:${subjectKey(result)}:${commit.sha}`;
  item.description = commitDescription(commit, Date.now());
  item.tooltip = commitTooltip(commit);
  item.iconPath = new vscode.ThemeIcon(commit.parents.length > 1 ? 'git-merge' : 'git-commit');
  item.contextValue = 'commit';
  item.command = { command: 'gitComparePlus.openCommit', title: 'Open Commit', arguments: [{ kind: 'commit', result, commit }] };
  return item;
}

function outcomeMessage(result: ComparisonResult): ChangesNode {
  switch (result.outcome) {
    case 'compared':
      return { kind: 'message', text: `No differences vs ${result.baseLabel ?? 'base'}`, icon: 'check' };
    case 'ref_missing':
      return { kind: 'message', text: `${result.baseLabel ?? 'Default branch'} not found in ${result.repo.name}`, icon: 'warning' };
    case 'failed':
      return { kind: 'message', text: `Failed: ${result.errorMessage ?? 'see Output → Git Compare+'}`, icon: 'error' };
  }
}

function resultItem(result: ComparisonResult, reviewedCount: number): vscode.TreeItem {
  const hasFiles = result.files.length > 0;
  const item = new vscode.TreeItem(result.repo.name, hasFiles ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  item.id = `result:${result.repo.commonDir}:${subjectKey(result)}`;
  const comparedTo = `${result.subject.label} against ${result.baseLabel ?? '?'}`;
  switch (result.outcome) {
    case 'compared':
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = [
        comparedTo,
        `${result.files.length} files`,
        ...(reviewedCount > 0 ? [`${reviewedCount} reviewed`] : []),
        totalLineStatsText(totalLineStats(result.files)),
      ].join(' · ');
      if ((result.excludedUncommitted.subject ?? 0) > 0) {
        // Committed-only comparison of a worktree with edits on disk: say so on the repo itself too.
        item.iconPath = new vscode.ThemeIcon('warning');
        item.description += ` · ${result.excludedUncommitted.subject} uncommitted NOT included`;
      }
      break;
    case 'ref_missing':
      item.iconPath = new vscode.ThemeIcon('warning');
      item.description = 'skipped: base branch not found';
      break;
    case 'failed':
      item.iconPath = new vscode.ThemeIcon('error');
      item.description = `failed: ${result.errorMessage ?? 'see log'}`;
      break;
  }
  item.tooltip = `${result.repo.root}\n${comparedTo}${result.baseRevision !== undefined ? `\nleft side: ${result.baseRevision.slice(0, 10)} (${result.mode === 'merge-base' ? 'branch point' : 'base'})` : ''}`;
  return item;
}

function fileItem(result: ComparisonResult, file: ChangedFile, reviewed: boolean, extensionUri: vscode.Uri, showFolder: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
  item.id = `file:${result.repo.commonDir}:${subjectKey(result)}:${file.path}`;
  item.checkboxState = {
    state: reviewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
    tooltip: file.fingerprint === undefined
      ? "Can't be marked reviewed: its content couldn't be read. Refresh to retry."
      : reviewed
        ? 'Reviewed. Clears by itself if the file changes on either side.'
        : 'Mark as reviewed',
  };
  // Custom scheme: file-type icon from the name + our status decoration (see module doc).
  item.resourceUri = changedFileUri(file, result.repo.commonDir);
  const directory = path.posix.dirname(file.path);
  const location = directory === '.' ? '' : directory;
  // Counts first: they are what the eye scans for while picking the next file to review, and a
  // long directory would otherwise push them out of the visible width.
  // In the tree layout the folder is the parent row, so only a rename's origin is worth repeating.
  const shownLocation = showFolder ? location : '';
  const where = file.status === 'renamed' ? `${shownLocation} ← ${file.oldPath}`.trim() : shownLocation;
  item.description = [originMark(file.origin), fileLineStatsText(file.lines), where].filter((part) => part.length > 0).join('  ');
  // iconPath wins over the file-type icon that resourceUri would give; resourceUri is still what
  // carries the status decoration (badge letter and label colour).
  const icon = diffBarIcon(file, extensionUri);
  if (icon !== undefined) {
    item.iconPath = icon;
  }
  item.tooltip = fileTooltip(file);
  // `changedFile.<status>[.both]`: Open File is hidden for deletions, Open File at Base for
  // additions; `.both` (committed + uncommitted) offers Open Committed / Uncommitted Changes.
  item.contextValue = `changedFile.${file.status}${hasBothOrigins(file) ? '.both' : ''}`;
  item.command = { command: 'gitComparePlus.openChange', title: 'Open Change', arguments: [{ kind: 'file', result, file }] };
  return item;
}

// Markdown so the counts can be green and red. appendText escapes the path (a file name may
// contain `*`, `_` or `<`); only our own fixed HTML goes through appendMarkdown.
function fileTooltip(file: ChangedFile): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportHtml = true;
  tooltip.appendText(`${STATUS_DECORATION[file.status].label}: ${file.path}`);
  if (file.status === 'renamed') {
    tooltip.appendText(`\nfrom ${file.oldPath}`);
  }
  const stats = lineStatsHoverHtml(file.lines);
  if (stats !== undefined) {
    tooltip.appendMarkdown(`\n\n${stats}`);
    // The same counts in words, so the hover does not rely on colour alone.
    if (file.lines !== undefined && !file.lines.binary) {
      tooltip.appendText(` (${lineStatsTooltip(file.lines) ?? ''})`);
    }
  }
  const origin = originTooltip(file.origin);
  if (origin !== undefined) {
    tooltip.appendText(`\n\n${origin}`);
  }
  return tooltip;
}

/**
 * Row URI for a changed file in any tree: our private scheme, so the status decoration of this
 * provider applies (A/M/D/R/U badge and colour) and the editor's own git decorations do not.
 */
export function changedFileUri(file: ChangedFile, repoKey: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ITEM_SCHEME, path: `/${file.path}`, query: new URLSearchParams({ status: file.status, repo: repoKey }).toString() });
}

/** The green/red diff-bar icon for a file's line counts; undefined keeps the file-type icon. */
export function diffBarIcon(file: ChangedFile, extensionUri: vscode.Uri): { light: vscode.Uri; dark: vscode.Uri } | undefined {
  const shape = diffBarShape(file.lines);
  return shape === undefined
    ? undefined
    : { light: vscode.Uri.joinPath(extensionUri, diffBarIconPath(shape, 'light')), dark: vscode.Uri.joinPath(extensionUri, diffBarIconPath(shape, 'dark')) };
}

function subjectKey(result: ComparisonResult): string {
  return result.subject.kind === 'worktree' ? `wt:${result.subject.root}` : `ref:${result.subject.ref}`;
}
