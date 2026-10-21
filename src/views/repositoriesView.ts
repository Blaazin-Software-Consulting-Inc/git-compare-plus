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
 * Order (treeOrder.ts): default branch, then main/master, then newest commit first; the main
 * worktree is always first. Each worktree/branch shows the age of its latest commit, and how many
 * commits it is ahead of / behind the repo's comparison base (`↑3 ↓12`, aheadBehind.ts).
 *
 * The repo row also shows when it was last fetched; comparisons against `origin/…` are only as
 * current as that fetch.
 *
 * Data is loaded lazily per repo on first expand and cached until Refresh, so opening the view in
 * a 10+ repo workspace costs one `git worktree list` per repo, not one per branch.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  aheadBehindBase,
  aheadBehindText,
  aheadBehindTooltip,
  loadAheadBehind,
  worktreeAheadBehind,
  type AheadBehind,
  type AheadBehindCounts,
} from '../aheadBehind';
import { baseLabel, baseMatches } from '../baseStore';
import { formatAge, isFetchStale } from '../operations';
import { FailureTracker, repositoriesStaleMessage } from '../autoRefresh/failureTracker';
import { stableSignature } from '../autoRefresh/scheduling';
import { sortBranches, sortWorktrees } from '../treeOrder';
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
  /** Worktree HEAD SHA → committer date (ms); shown as the worktree's age. */
  readonly worktreeDates: ReadonlyMap<string, number>;
  /** Commits ahead/behind the comparison base at load time; undefined when unavailable. */
  readonly aheadBehind?: AheadBehindCounts;
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
  /** A background reload of `repoName` keeps failing (called once per failure episode). */
  onPersistentFailure(repoName: string, reason: string): void;
  readonly logger: Logger;
}

/** Tree data provider for the Repositories view. */
export class RepositoriesProvider implements vscode.TreeDataProvider<RepoTreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  // Promise caches: concurrent expands of the same repo share one git invocation.
  private repos: Promise<RepoInfo[]> | undefined;
  private readonly details = new Map<string, Promise<RepoDetails>>();
  // commonDir → repo, for refreshes that arrive keyed by common dir (git change events).
  private knownRepos = new Map<string, RepoInfo>();
  // Background reload failures per repo (commonDir). While a repo has an episode, its row shows a
  // warning and the view's message bar says the data is from before (see failureTracker.ts).
  private readonly failures = new FailureTracker<string>();
  private view: vscode.TreeView<RepoTreeNode> | undefined;

  constructor(private readonly deps: RepositoriesViewDeps) {}

  /** Attach the TreeView so the stale-data message can be shown in its message bar. */
  attach(view: vscode.TreeView<RepoTreeNode>): void {
    this.view = view;
  }

  /** Recompute the message bar (minute timer: keeps "2 min ago" current). */
  refreshMessage(): void {
    if (this.view === undefined) {
      return;
    }
    const failing = this.failures.all().flatMap(([commonDir, episode]) => {
      const repo = this.knownRepos.get(commonDir);
      return repo === undefined ? [] : [{ name: repo.name, episode }];
    });
    this.view.message = repositoriesStaleMessage(failing, Date.now());
  }

  /** Drop every cache and redraw (Refresh button; also after the workspace folders change). */
  refresh(): void {
    this.repos = undefined;
    this.details.clear();
    this.changeEmitter.fire();
  }

  /**
   * Automatic refresh (git change events): reload a repo's data in the background and redraw only
   * if something actually changed. Repos never expanded have nothing cached and are skipped; they
   * load fresh when opened. Never throws; a failed reload keeps the old data (logged at WARN).
   */
  async refreshRepoIfChanged(commonDir: string): Promise<void> {
    const repo = this.knownRepos.get(commonDir);
    const current = this.details.get(commonDir);
    if (repo === undefined || current === undefined) {
      return;
    }
    try {
      const [before, after] = await Promise.all([current.catch(() => undefined), this.loadDetails(repo)]);
      const recovered = this.failures.recordSuccess(commonDir);
      // The cache may have been replaced meanwhile (manual Refresh, a git action); keep the newer.
      const replaced = this.details.get(commonDir) !== current;
      const unchanged = before !== undefined && stableSignature(before) === stableSignature(after);
      if (!replaced && !unchanged) {
        this.details.set(commonDir, Promise.resolve(after));
      }
      if (recovered) {
        this.refreshMessage();
      }
      if ((!replaced && !unchanged) || recovered) {
        this.changeEmitter.fire();
      }
    } catch (error) {
      this.recordBackgroundFailure(repo, error);
    }
  }

  // Background failure: keep showing the previous data, mark the repo and the message bar, and
  // escalate once per episode if it persists. Each failure is WARN; a persistent one is ERROR.
  private recordBackgroundFailure(repo: RepoInfo, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const { notify, episode } = this.failures.recordFailure(repo.commonDir, reason, Date.now());
    this.deps.logger.warn('background repository reload failed; keeping previous data', {
      function: 'refreshRepoIfChanged',
      repo: repo.name,
      reason,
      consecutiveFailures: episode.consecutive,
      failingSince: new Date(episode.since).toISOString(),
    });
    if (notify) {
      this.deps.logger.error('background repository reload keeps failing', error, {
        function: 'refreshRepoIfChanged',
        repo: repo.name,
        consecutiveFailures: episode.consecutive,
        failingSince: new Date(episode.since).toISOString(),
      });
      this.deps.onPersistentFailure(repo.name, reason);
    }
    this.refreshMessage();
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

  /** Redraw without reloading git data (e.g. the minute timer for ages). */
  redraw(): void {
    this.changeEmitter.fire();
  }

  /** Repos currently shown, discovering them if the view has not loaded yet. */
  getRepos(): Promise<RepoInfo[]> {
    this.repos ??= this.deps.discoverRepos().then((repos) => {
      this.knownRepos = new Map(repos.map((r) => [r.commonDir, r]));
      return repos;
    });
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
      case 'worktree': {
        const counts = await this.aheadBehindCounts(node.repo);
        return worktreeItem(node.repo, node.worktree, node.isMain, this.deps.getBase(node.repo), await this.worktreeDate(node.repo, node.worktree), {
          counts: worktreeAheadBehind(counts, node.worktree),
          baseLabel: counts?.baseLabel,
        });
      }
      case 'branch': {
        const counts = await this.aheadBehindCounts(node.repo);
        return branchItem(node.repo, node.ref, node.checkedOutIn, this.deps.getBase(node.repo), { counts: counts?.byRef.get(node.ref.name), baseLabel: counts?.baseLabel });
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  private async aheadBehindCounts(repo: RepoInfo): Promise<AheadBehindCounts | undefined> {
    return (await this.getDetails(repo)).aheadBehind;
  }

  private async worktreeDate(repo: RepoInfo, worktree: WorktreeEntry): Promise<number | undefined> {
    return worktree.head === undefined ? undefined : (await this.getDetails(repo)).worktreeDates.get(worktree.head);
  }

  private getDetails(repo: RepoInfo): Promise<RepoDetails> {
    let pending = this.details.get(repo.commonDir);
    if (pending === undefined) {
      pending = this.loadDetails(repo);
      // Don't cache a failure: the next expand (or Refresh) should retry.
      pending.catch(() => this.details.delete(repo.commonDir));
      // A successful load (manual Refresh, expand, after a git action) ends any failure episode.
      pending.then(
        () => {
          if (this.failures.recordSuccess(repo.commonDir)) {
            this.refreshMessage();
            this.changeEmitter.fire();
          }
        },
        () => undefined,
      );
      this.details.set(repo.commonDir, pending);
    }
    return pending;
  }

  // Sorted once here (treeOrder.ts) so the tree, the Compare With… picker and the delete
  // dialogs all list worktrees and branches in the same order.
  private async loadDetails(repo: RepoInfo): Promise<RepoDetails> {
    const git = await this.deps.getGit();
    const [worktrees, refs, lastFetchedAt, defaultBranch] = await Promise.all([
      git.worktrees(repo.root),
      git.refs(repo.root),
      git.lastFetchedAt(repo.root),
      git.defaultBranch(repo.root),
    ]);
    // Counted against the base the compare button uses, so `↑3` means "3 commits that compare
    // would show". A base change (Set/Clear Comparison Base) reloads the repo to recount.
    const countBase = aheadBehindBase(this.deps.getBase(repo), defaultBranch, worktrees);
    const [commitDates, aheadBehind] = await Promise.all([
      this.worktreeCommitDates(git, repo, worktrees),
      countBase === undefined ? undefined : loadAheadBehind(git, repo.root, countBase, refs, worktrees, this.deps.logger),
    ]);
    this.deps.logger.debug('repository details loaded', {
      function: 'loadDetails',
      repo: repo.name,
      worktreeCount: worktrees.length,
      refCount: refs.length,
      lastFetchedAt,
      defaultBranch,
      aheadBehindBase: countBase?.label,
      aheadBehindCount: aheadBehind?.byRef.size,
    });
    return {
      worktrees: sortWorktrees(worktrees, defaultBranch, commitDates),
      refs: sortBranches(refs, defaultBranch),
      lastFetchedAt,
      worktreeDates: commitDates,
      aheadBehind,
    };
  }

  private async worktreeCommitDates(git: GitCli, repo: RepoInfo, worktrees: readonly WorktreeEntry[]): Promise<Map<string, number>> {
    const heads = worktrees.flatMap((w) => (w.head !== undefined && !w.bare && !w.prunable ? [w.head] : []));
    try {
      return await git.commitDates(repo.root, heads);
    } catch (error) {
      // Ordering is cosmetic: fall back to name order rather than failing the whole repo.
      this.deps.logger.warn('worktree commit dates unavailable; ordering by name', {
        function: 'worktreeCommitDates',
        repo: repo.name,
        heads,
        reason: error instanceof Error ? error.message : String(error),
      });
      return new Map();
    }
  }

  private async groupNodes(repo: RepoInfo): Promise<RepoTreeNode[]> {
    await this.getDetails(repo);
    return (['worktrees', 'branches', 'remotes'] as const).map((group) => ({ kind: 'group', repo, group }));
  }

  private async groupChildren(repo: RepoInfo, group: GroupKind): Promise<RepoTreeNode[]> {
    const details = await this.getDetails(repo);
    if (group === 'worktrees') {
      // Stale entries (directory deleted without `git worktree remove`) cannot be diffed.
      // Main = git's first entry (kept first by sortWorktrees), compared by path so filtering a
      // bare main entry cannot promote a linked worktree to "main".
      const mainPath = details.worktrees[0]?.path;
      return details.worktrees
        .filter((w) => !w.bare && !w.prunable)
        .map((worktree) => ({ kind: 'worktree', repo, worktree, isMain: worktree.path === mainPath }));
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
    // A failing background reload outranks the fetch hint: what is shown here may be out of date.
    const failure = this.failures.get(repo.commonDir);
    if (failure !== undefined) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      item.tooltip += `\nCouldn't refresh (${formatAge(failure.lastAt, Date.now())}): ${failure.reason}\nShowing earlier data. Refresh to retry.`;
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

function worktreeItem(
  repo: RepoInfo,
  worktree: WorktreeEntry,
  isMain: boolean,
  base: BaseSpec | undefined,
  committedAt: number | undefined,
  position: RowAheadBehind,
): vscode.TreeItem {
  const label = worktree.branch ?? `detached @ ${(worktree.head ?? '').slice(0, 7)}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  const isBase = baseMatches(base, { worktreeRoot: worktree.path });
  item.id = `worktree:${worktree.path}`;
  item.iconPath = new vscode.ThemeIcon(isBase ? 'target' : isMain ? 'home' : 'folder');
  const location = isMain ? 'main worktree' : displayPath(repo.root, worktree.path);
  // Age of the latest commit, so the newest-first order is visible.
  const age = committedAt === undefined ? undefined : formatAge(committedAt, Date.now());
  item.description = [isBase ? 'comparison base' : undefined, aheadBehindText(position.counts), location, age].filter(Boolean).join(' · ');
  item.tooltip = withAheadBehindTooltip(worktree.path, position);
  item.contextValue = `comparable.worktree${isMain ? '.main' : ''}${isBase ? '.base' : ''}`;
  return item;
}

function branchItem(repo: RepoInfo, ref: RefEntry, checkedOutIn: string | undefined, base: BaseSpec | undefined, position: RowAheadBehind): vscode.TreeItem {
  const item = new vscode.TreeItem(ref.name, vscode.TreeItemCollapsibleState.None);
  const isBase = baseMatches(base, { ref: ref.name });
  item.id = `branch:${repo.commonDir}:${ref.kind}:${ref.name}`;
  item.iconPath = new vscode.ThemeIcon(isBase ? 'target' : ref.kind === 'remote' ? 'cloud' : checkedOutIn !== undefined ? 'check' : 'git-branch');
  const checkedOut = checkedOutIn !== undefined ? `in ${checkedOutIn === repo.root ? 'main worktree' : path.basename(checkedOutIn)}` : undefined;
  const detail = checkedOut ?? (ref.upstream !== undefined ? `→ ${ref.upstream}` : undefined);
  const age = ref.committedAt === undefined ? undefined : formatAge(ref.committedAt, Date.now());
  item.description = [isBase ? 'comparison base' : undefined, aheadBehindText(position.counts), detail, age].filter(Boolean).join(' · ');
  item.tooltip = withAheadBehindTooltip(`${ref.name} @ ${ref.sha}${checkedOutIn !== undefined ? `\nchecked out in ${checkedOutIn}` : ''}`, position);
  item.contextValue = `comparable.branch.${ref.kind}${checkedOutIn !== undefined ? '.checkedOut' : ''}${isBase ? '.base' : ''}`;
  return item;
}

/** A row's commit counts and what they are relative to (both undefined when unavailable). */
interface RowAheadBehind {
  readonly counts: AheadBehind | undefined;
  readonly baseLabel: string | undefined;
}

function withAheadBehindTooltip(tooltip: string, position: RowAheadBehind): string {
  const line = position.baseLabel === undefined ? undefined : aheadBehindTooltip(position.counts, position.baseLabel);
  return line === undefined ? tooltip : `${tooltip}\n${line}`;
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
