/**
 * repositoriesView — the "Repositories" tree in the Branch & Worktree Compare sidebar.
 *
 * Shape:
 *   repo                       (the main worktree; description = checked-out branch)
 *   ├─ Worktrees (n)           every worktree incl. the main one; e.g. `.claude/worktrees/*`
 *   ├─ Branches (n)            local branches
 *   └─ Remote Branches (n)     remote-tracking branches (collapsed)
 *
 * Repo, worktree and branch nodes are "comparable": they carry an inline compare button (compares
 * with the repo's comparison base, i.e. its default branch unless one was set) and a context menu
 * (Compare With…, Set as Comparison Base). The item that IS the repo's base is marked with a target
 * icon, and the repo row says what its base is. `contextValue` encodes all of this for the menus:
 *   comparable.repo[.hasBase]
 *   comparable.worktree[.main][.base]
 *   comparable.branch.local[.checkedOut][.base] | comparable.branch.remote[.base]
 * `.checkedOut` = checked out in some worktree; such a branch cannot be deleted, switched to, or
 * given a second worktree (git refuses), so those menu entries are hidden for it.
 *
 * The repo row also shows when it was last fetched; comparisons against `origin/…` are only as
 * current as that fetch.
 *
 * Data is loaded lazily per repo on first expand and cached until Refresh, so opening the view in
 * a 10+ repo workspace costs one `git worktree list` per repo, not one per branch.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { baseLabel, baseMatches } from '../baseStore';
import { formatAge, isFetchStale } from '../operations';
import type { BaseSpec, RepoInfo, Subject } from '../comparison';
import type { GitCli } from '../git/gitCli';
import type { RefEntry, WorktreeEntry } from '../git/parsers';
import type { Logger } from '../logger';

/** Per-repo data behind the group nodes. */
interface RepoDetails {
  readonly worktrees: readonly WorktreeEntry[];
  readonly refs: readonly RefEntry[];
  /** mtime of FETCH_HEAD in ms; undefined = never fetched. */
  readonly lastFetchedAt?: number;
}

type GroupKind = 'worktrees' | 'branches' | 'remotes';

/** Tree nodes. `repo`, `worktree` and `branch` nodes are comparable (see `toComparisonTarget`). */
export type RepoTreeNode =
  | { readonly kind: 'repo'; readonly repo: RepoInfo }
  | { readonly kind: 'group'; readonly repo: RepoInfo; readonly group: GroupKind }
  | { readonly kind: 'worktree'; readonly repo: RepoInfo; readonly worktree: WorktreeEntry; readonly isMain: boolean }
  | { readonly kind: 'branch'; readonly repo: RepoInfo; readonly ref: RefEntry; readonly checkedOutIn?: string }
  | { readonly kind: 'message'; readonly text: string; readonly icon: string };

/** Collaborators the view needs; resolved lazily because the git extension activates async. */
export interface RepositoriesViewDeps {
  getGit(): Promise<GitCli>;
  discoverRepos(): Promise<RepoInfo[]>;
  /** The comparison base the user set for a repo (baseStore.ts); undefined = default branch. */
  getBase(repo: RepoInfo): BaseSpec | undefined;
  /** Hours after which a repo's last fetch is flagged as stale (setting `branchCompare.staleFetchHours`). */
  staleFetchHours(): number;
  readonly logger: Logger;
}

/** Tree data provider for the Repositories view. */
export class RepositoriesProvider implements vscode.TreeDataProvider<RepoTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  // Promise caches: concurrent expands of the same repo share one git invocation.
  private repos: Promise<RepoInfo[]> | undefined;
  private readonly details = new Map<string, Promise<RepoDetails>>();

  constructor(private readonly deps: RepositoriesViewDeps) {}

  /** Drop every cache and redraw (Refresh button; also after the workspace folders change). */
  refresh(): void {
    this.repos = undefined;
    this.details.clear();
    this.changeEmitter.fire();
  }

  /** Reload one repo's worktrees, branches and fetch time (after a git action on it). */
  refreshRepo(repo: RepoInfo): void {
    this.details.delete(repo.commonDir);
    this.changeEmitter.fire();
  }

  /** Last fetch time of a repo (cached with its details). */
  async getLastFetchedAt(repo: RepoInfo): Promise<number | undefined> {
    return (await this.getDetails(repo)).lastFetchedAt;
  }

  /** Redraw without reloading git data (e.g. after the comparison base changed). */
  redraw(): void {
    this.changeEmitter.fire();
  }

  /** Repos currently shown, discovering them if the view has not loaded yet. */
  getRepos(): Promise<RepoInfo[]> {
    this.repos ??= this.deps.discoverRepos();
    return this.repos;
  }

  /** Branches of one repo (cached); used by the "Compare with…" picker. */
  async getRefs(repo: RepoInfo): Promise<readonly RefEntry[]> {
    return (await this.getDetails(repo)).refs;
  }

  /** Usable (non-bare, non-stale) worktrees of one repo, main first (cached). */
  async getWorktrees(repo: RepoInfo): Promise<readonly WorktreeEntry[]> {
    return (await this.getDetails(repo)).worktrees.filter((w) => !w.bare && !w.prunable);
  }

  async getChildren(node?: RepoTreeNode): Promise<RepoTreeNode[]> {
    try {
      if (node === undefined) {
        const repos = await this.getRepos();
        return repos.length > 0
          ? repos.map((repo) => ({ kind: 'repo', repo }))
          : [{ kind: 'message', text: 'No git repositories in this window', icon: 'info' }];
      }
      switch (node.kind) {
        case 'repo':
          return this.groupNodes(node.repo);
        case 'group':
          return this.groupChildren(node.repo, node.group);
        default:
          return [];
      }
    } catch (error) {
      // Absorbed so the view shows a readable message instead of an endless spinner.
      this.deps.logger.error('repositories view load failed', error, {
        function: 'getChildren',
        node: describeNode(node),
      });
      return [{ kind: 'message', text: `Could not load: ${error instanceof Error ? error.message : String(error)}`, icon: 'error' }];
    }
  }

  async getTreeItem(node: RepoTreeNode): Promise<vscode.TreeItem> {
    switch (node.kind) {
      case 'repo':
        return this.repoItem(node.repo);
      case 'group':
        return this.groupItem(node.repo, node.group);
      case 'worktree':
        return worktreeItem(node.repo, node.worktree, node.isMain, this.deps.getBase(node.repo));
      case 'branch':
        return branchItem(node.repo, node.ref, node.checkedOutIn, this.deps.getBase(node.repo));
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  private getDetails(repo: RepoInfo): Promise<RepoDetails> {
    let pending = this.details.get(repo.commonDir);
    if (pending === undefined) {
      pending = this.loadDetails(repo);
      // Don't cache a failure: the next expand (or Refresh) should retry.
      pending.catch(() => this.details.delete(repo.commonDir));
      this.details.set(repo.commonDir, pending);
    }
    return pending;
  }

  private async loadDetails(repo: RepoInfo): Promise<RepoDetails> {
    const git = await this.deps.getGit();
    const [worktrees, refs, lastFetchedAt] = await Promise.all([git.worktrees(repo.root), git.refs(repo.root), git.lastFetchedAt(repo.root)]);
    this.deps.logger.debug('repository details loaded', {
      function: 'loadDetails',
      repo: repo.name,
      worktreeCount: worktrees.length,
      refCount: refs.length,
      lastFetchedAt,
    });
    return { worktrees, refs, lastFetchedAt };
  }

  private async groupNodes(repo: RepoInfo): Promise<RepoTreeNode[]> {
    await this.getDetails(repo);
    return (['worktrees', 'branches', 'remotes'] as const).map((group) => ({ kind: 'group', repo, group }));
  }

  private async groupChildren(repo: RepoInfo, group: GroupKind): Promise<RepoTreeNode[]> {
    const details = await this.getDetails(repo);
    if (group === 'worktrees') {
      // Stale entries (directory deleted without `git worktree remove`) cannot be diffed.
      return details.worktrees
        .filter((w) => !w.bare && !w.prunable)
        .map((worktree, index) => ({ kind: 'worktree', repo, worktree, isMain: index === 0 }));
    }
    const kind = group === 'branches' ? 'local' : 'remote';
    // Branch → worktree path holding it; the main worktree's branch is included.
    const holders = new Map(details.worktrees.filter((w) => w.branch !== undefined).map((w) => [w.branch, w.path]));
    return details.refs
      .filter((r) => r.kind === kind)
      .map((ref) => ({ kind: 'branch', repo, ref, checkedOutIn: ref.kind === 'local' ? holders.get(ref.name) : undefined }));
  }

  private async repoItem(repo: RepoInfo): Promise<vscode.TreeItem> {
    const repos = await this.getRepos();
    // A single-repo window opens expanded: there is nothing else to choose between.
    const state = repos.length === 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(repo.name, state);
    item.id = `repo:${repo.commonDir}`;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.tooltip = repo.root;
    const base = this.deps.getBase(repo);
    item.contextValue = base !== undefined ? 'comparable.repo.hasBase' : 'comparable.repo';
    const details = this.details.has(repo.commonDir) ? await this.getDetails(repo) : undefined;
    const main = details?.worktrees[0];
    const now = Date.now();
    const fetched = details === undefined ? undefined : `fetched ${formatAge(details.lastFetchedAt, now)}`;
    const stale = details !== undefined && isFetchStale(details.lastFetchedAt, now, this.deps.staleFetchHours());
    // Only a non-default base is called out; the default needs no explanation.
    item.description = [main?.branch, base !== undefined ? `base: ${baseLabel(base)}` : undefined, fetched].filter(Boolean).join(' · ');
    item.tooltip = `${repo.root}${stale ? '\nNot fetched recently: comparisons with origin/… may be out of date. Right-click → Fetch.' : ''}`;
    if (stale) {
      item.iconPath = new vscode.ThemeIcon('repo', new vscode.ThemeColor('list.warningForeground'));
    }
    return item;
  }

  private async groupItem(repo: RepoInfo, group: GroupKind): Promise<vscode.TreeItem> {
    const details = await this.getDetails(repo);
    const labels: Record<GroupKind, string> = { worktrees: 'Worktrees', branches: 'Branches', remotes: 'Remote Branches' };
    const icons: Record<GroupKind, string> = { worktrees: 'list-tree', branches: 'git-branch', remotes: 'cloud' };
    const count =
      group === 'worktrees'
        ? details.worktrees.filter((w) => !w.bare && !w.prunable).length
        : details.refs.filter((r) => r.kind === (group === 'branches' ? 'local' : 'remote')).length;
    // Remote branch lists are long and rarely the subject of a review; keep them out of the way.
    const state = group === 'remotes' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(labels[group], count > 0 ? state : vscode.TreeItemCollapsibleState.None);
    item.id = `group:${repo.commonDir}:${group}`;
    item.description = String(count);
    item.iconPath = new vscode.ThemeIcon(icons[group]);
    return item;
  }
}

function worktreeItem(repo: RepoInfo, worktree: WorktreeEntry, isMain: boolean, base: BaseSpec | undefined): vscode.TreeItem {
  const label = worktree.branch ?? `detached @ ${(worktree.head ?? '').slice(0, 7)}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  const isBase = baseMatches(base, { worktreeRoot: worktree.path });
  item.id = `worktree:${worktree.path}`;
  item.iconPath = new vscode.ThemeIcon(isBase ? 'target' : isMain ? 'home' : 'folder');
  const location = isMain ? 'main worktree' : displayPath(repo.root, worktree.path);
  item.description = isBase && base !== undefined ? `comparison base · ${location}` : location;
  item.tooltip = worktree.path;
  item.contextValue = `comparable.worktree${isMain ? '.main' : ''}${isBase ? '.base' : ''}`;
  return item;
}

function branchItem(repo: RepoInfo, ref: RefEntry, checkedOutIn: string | undefined, base: BaseSpec | undefined): vscode.TreeItem {
  const item = new vscode.TreeItem(ref.name, vscode.TreeItemCollapsibleState.None);
  const isBase = baseMatches(base, { ref: ref.name });
  item.id = `branch:${repo.commonDir}:${ref.kind}:${ref.name}`;
  item.iconPath = new vscode.ThemeIcon(isBase ? 'target' : ref.kind === 'remote' ? 'cloud' : checkedOutIn !== undefined ? 'check' : 'git-branch');
  const checkedOut = checkedOutIn !== undefined ? `in ${checkedOutIn === repo.root ? 'main worktree' : path.basename(checkedOutIn)}` : undefined;
  const detail = checkedOut ?? (ref.upstream !== undefined ? `→ ${ref.upstream}` : undefined);
  item.description = isBase ? ['comparison base', detail].filter(Boolean).join(' · ') : detail;
  item.tooltip = `${ref.name} @ ${ref.sha}${checkedOutIn !== undefined ? `\nchecked out in ${checkedOutIn}` : ''}`;
  item.contextValue = `comparable.branch.${ref.kind}${checkedOutIn !== undefined ? '.checkedOut' : ''}${isBase ? '.base' : ''}`;
  return item;
}

/** Paths inside the repo are shown relative (`.claude/worktrees/x`); others with `~` for home. */
function displayPath(repoRoot: string, target: string): string {
  const relative = path.relative(repoRoot, target);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  const home = process.env.HOME;
  return home !== undefined && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

/**
 * The repo + subject a comparable node stands for, or `undefined` for non-comparable nodes.
 * A repo node means its main worktree. `includeUncommitted` applies to worktree subjects only.
 */
export function toComparisonTarget(
  node: RepoTreeNode,
  mainBranch: string | undefined,
  includeUncommitted: boolean,
): { repo: RepoInfo; subject: Subject } | undefined {
  switch (node.kind) {
    case 'repo':
      return { repo: node.repo, subject: { kind: 'worktree', root: node.repo.root, label: mainBranch ?? node.repo.name, includeUncommitted } };
    case 'worktree':
      return {
        repo: node.repo,
        subject: { kind: 'worktree', root: node.worktree.path, label: worktreeLabel(node.worktree), includeUncommitted },
      };
    case 'branch':
      return { repo: node.repo, subject: { kind: 'ref', ref: node.ref.name, label: node.ref.name } };
    default:
      return undefined;
  }
}

/** Display name for a worktree: its branch, or the folder name when detached. */
export function worktreeLabel(worktree: WorktreeEntry): string {
  return worktree.branch ?? path.basename(worktree.path);
}

function describeNode(node: RepoTreeNode | undefined): unknown {
  if (node === undefined) {
    return 'root';
  }
  return node.kind === 'message' ? { kind: node.kind } : { kind: node.kind, repo: node.repo.name };
}
