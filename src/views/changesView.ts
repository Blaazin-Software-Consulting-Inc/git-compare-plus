/**
 * changesView — the "Changes" tree: files changed by the current comparison.
 *
 * Shape:
 *   - One comparison (one repo): files at the root; the view description says what was compared.
 *   - Several (e.g. "Compare all repos"): a node per repo that has changes, skipped, or failed;
 *     repos with no changes are left out and counted in the view message.
 *
 * Clicking a file runs `branchCompare.openChange`, which opens the diff editor (extension.ts).
 * Status letters and colors come from a FileDecorationProvider on the private
 * `branch-compare-item:` scheme. Using real file URIs as `resourceUri` would make the editor's own git
 * decorations (relative to HEAD, not to the comparison base) appear and contradict ours.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ComparisonResult } from '../comparison';
import type { ChangedFile, FileStatus } from '../git/parsers';
import { describeHeader, type BaseFetchInfo, type ComparisonSetup, type HeaderRow } from './changesHeader';

const ITEM_SCHEME = 'branch-compare-item';

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
  | { readonly kind: 'message'; readonly text: string; readonly icon: string };

const STATUS_DECORATION: Record<FileStatus, { badge: string; color: string; label: string }> = {
  added: { badge: 'A', color: 'gitDecoration.addedResourceForeground', label: 'Added' },
  untracked: { badge: 'U', color: 'gitDecoration.untrackedResourceForeground', label: 'Untracked' },
  modified: { badge: 'M', color: 'gitDecoration.modifiedResourceForeground', label: 'Modified' },
  deleted: { badge: 'D', color: 'gitDecoration.deletedResourceForeground', label: 'Deleted' },
  renamed: { badge: 'R', color: 'gitDecoration.renamedResourceForeground', label: 'Renamed' },
};

/** Tree data + decoration provider for the Changes view. */
export class ChangesProvider implements vscode.TreeDataProvider<ChangesNode>, vscode.FileDecorationProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private state: ChangesState | undefined;
  private view: vscode.TreeView<ChangesNode> | undefined;

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
    void vscode.commands.executeCommand('setContext', 'branchCompare.hasComparison', true);
    this.changeEmitter.fire();
  }

  /** Back to the empty welcome state. */
  clear(): void {
    this.state = undefined;
    this.updateViewChrome();
    void vscode.commands.executeCommand('setContext', 'branchCompare.hasComparison', false);
    this.changeEmitter.fire();
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
      return fileNodes(node.result);
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
      return only.outcome === 'compared' && only.files.length > 0 ? fileNodes(only) : [outcomeMessage(only)];
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
        return resultItem(node.result);
      case 'file':
        return fileItem(node.result, node.file);
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
    this.view.description = this.state === undefined ? undefined : `${fileCount} file${fileCount === 1 ? '' : 's'}`;
    if (results.length > 1) {
      const changed = results.filter((r) => r.files.length > 0).length;
      this.view.message = `${fileCount} files in ${changed} of ${results.length} repositories`;
    } else {
      this.view.message = undefined;
    }
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

function outcomeMessage(result: ComparisonResult): ChangesNode {
  switch (result.outcome) {
    case 'compared':
      return { kind: 'message', text: `No differences vs ${result.baseLabel ?? 'base'}`, icon: 'check' };
    case 'ref_missing':
      return { kind: 'message', text: `${result.baseLabel ?? 'Default branch'} not found in ${result.repo.name}`, icon: 'warning' };
    case 'failed':
      return { kind: 'message', text: `Failed: ${result.errorMessage ?? 'see Output → Git Branch & Worktree Compare'}`, icon: 'error' };
  }
}

function resultItem(result: ComparisonResult): vscode.TreeItem {
  const hasFiles = result.files.length > 0;
  const item = new vscode.TreeItem(result.repo.name, hasFiles ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  item.id = `result:${result.repo.commonDir}:${subjectKey(result)}`;
  const comparedTo = `${result.subject.label} ↔ ${result.baseLabel ?? '?'}`;
  switch (result.outcome) {
    case 'compared':
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = `${comparedTo} · ${result.files.length} files`;
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

function fileItem(result: ComparisonResult, file: ChangedFile): vscode.TreeItem {
  const item = new vscode.TreeItem(path.posix.basename(file.path), vscode.TreeItemCollapsibleState.None);
  item.id = `file:${result.repo.commonDir}:${subjectKey(result)}:${file.path}`;
  // Custom scheme: file-type icon from the name + our status decoration (see module doc).
  item.resourceUri = vscode.Uri.from({
    scheme: ITEM_SCHEME,
    path: `/${file.path}`,
    query: new URLSearchParams({ status: file.status, repo: result.repo.commonDir }).toString(),
  });
  const directory = path.posix.dirname(file.path);
  const location = directory === '.' ? '' : directory;
  item.description = file.status === 'renamed' ? `${location} ← ${file.oldPath}`.trim() : location;
  item.tooltip = `${STATUS_DECORATION[file.status].label}: ${file.path}`;
  item.contextValue = 'changedFile';
  item.command = { command: 'branchCompare.openChange', title: 'Open Change', arguments: [{ kind: 'file', result, file }] };
  return item;
}

function subjectKey(result: ComparisonResult): string {
  return result.subject.kind === 'worktree' ? `wt:${result.subject.root}` : `ref:${result.subject.ref}`;
}
