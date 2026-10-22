/**
 * repositoriesView — the "Repositories" tree in the Git Compare+ sidebar.
 *
 * Shape:
 *   repo                       (the main worktree; description = checked-out branch)
 *   ├─ Worktrees (n)           every worktree incl. the main one; e.g. `.claude/worktrees/*`
 *   ├─ Branches (n)            local branches
 *   ├─ Remote Branches (n)     remote-tracking branches (collapsed)
 *   └─ Stashes (n)             the repo's stashes (collapsed); each expands to its files
 *
 * Repo, worktree and branch nodes are "comparable": they carry an inline compare button (reviews
 * the item against the repo's default "Against", i.e. its default branch unless one was set) and a
 * context menu (Review Against…, Use as Default Against). The item that IS the repo's default
 * Against is marked with a target icon, and the repo row always says what one-click compares
 * against (`against origin/main`). Internally that saved side is still called the "base"
 * (baseStore.ts). `contextValue` encodes all of this for the menus:
 *   comparable.repo[.hasBase]
 *   comparable.worktree[.main][.base]
 *   comparable.branch.local[.checkedOut][.base] | comparable.branch.remote[.base]
 * `.checkedOut` = checked out in some worktree; such a branch cannot be deleted, switched to, or
 * given a second worktree (git refuses), so those menu entries are hidden for it.
 *
 * Order (treeOrder.ts): default branch, then main/master, then newest commit first; the main
 * worktree is always first. Each worktree/branch shows the age of its latest commit, and how many
 * commits it is ahead of / behind the repo's default Against (`↑3 ↓12`, aheadBehind.ts).
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
import { branchLocation, locationText, type BranchLocation } from '../branchLocation';
import { formatAge, isFetchStale } from '../operations';
import { displayPath, isOneOf } from '../paths';
import { FailureTracker, repositoriesStaleMessage } from '../autoRefresh/failureTracker';
import { stableSignature } from '../autoRefresh/scheduling';
import { sortBranches, sortWorktrees } from '../treeOrder';
import type { BaseSpec, RepoInfo, Subject } from '../comparison';
import type { GitCli } from '../git/gitCli';
import type { RefEntry, StashEntry, WorktreeEntry } from '../git/parsers';
import { stashDescription, stashFiles, stashLabel, stashTooltip, type StashFile } from '../stashes';
import { changedFileUri, diffBarIcon } from './changesView';
import { fileLineStatsText } from './lineStatsText';
import type { Logger } from '../logger';

/** Per-repo data behind the group nodes. */
interface RepoDetails {
  readonly worktrees: readonly WorktreeEntry[];
  readonly refs: readonly RefEntry[];
  /** mtime of FETCH_HEAD in ms; undefined = never fetched. */
  readonly lastFetchedAt?: number;
  /** Worktree HEAD SHA → committer date (ms); shown as the worktree's age. */
  readonly worktreeDates: ReadonlyMap<string, number>;
  /** Commits ahead/behind the default Against at load time; undefined when unavailable. */
  readonly aheadBehind?: AheadBehindCounts;
  /** The repo's default branch at load time (defaultBranch.ts); undefined when none was found. */
  readonly defaultBranch?: string;
  /** The repo's stashes, newest first (shared by all its worktrees). */
  readonly stashes: readonly StashEntry[];
}

type GroupKind = 'worktrees' | 'branches' | 'remotes' | 'stashes';

/** Tree nodes. `repo`, `worktree` and `branch` nodes are comparable (see `toComparisonTarget`). */
export type RepoTreeNode =
  | { readonly kind: 'repo'; readonly repo: RepoInfo }
  | { readonly kind: 'group'; readonly repo: RepoInfo; readonly group: GroupKind }
  | { readonly kind: 'worktree'; readonly repo: RepoInfo; readonly worktree: WorktreeEntry; readonly isMain: boolean }
  | { readonly kind: 'stash'; readonly repo: RepoInfo; readonly stash: StashEntry }
  | { readonly kind: 'stashFile'; readonly repo: RepoInfo; readonly stash: StashEntry; readonly entry: StashFile }
  | { readonly kind: 'branch'; readonly repo: RepoInfo; readonly ref: RefEntry; readonly checkedOutIn?: string }
  | { readonly kind: 'message'; readonly text: string; readonly icon: string };

/** Collaborators the view needs; resolved lazily because the git extension activates async. */
export interface RepositoriesViewDeps {
  getGit(): Promise<GitCli>;
  discoverRepos(): Promise<RepoInfo[]>;
  /** The comparison base the user set for a repo (baseStore.ts); undefined = default branch. */
  getBase(repo: RepoInfo): BaseSpec | undefined;
  /** Hours after which a repo's last fetch is flagged as stale (setting `gitComparePlus.staleFetchHours`). */
  staleFetchHours(): number;
  /** Extension root, for the diff-bar icons on stash files. */
  readonly extensionUri: vscode.Uri;
  /** Folders open in this window (workspace folders), to mark "this window" worktrees. */
  windowFolders(): readonly string[];
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
  // Worktree lists of repos whose details are not loaded (getWorktreesLight); cleared with them.
  private readonly lightWorktrees = new Map<string, Promise<readonly WorktreeEntry[]>>();
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
    this.lightWorktrees.clear();
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
    // A git change in a repo that was never expanded: its worktree list may be stale too.
    this.lightWorktrees.delete(commonDir);
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
    this.lightWorktrees.delete(repo.commonDir);
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

  /**
   * Usable worktrees of one repo without loading the rest of its details: the cached list when
   * the repo was already loaded, otherwise one `git worktree list`, cached until that repo next
   * changes or Refresh. For the status
   * bar, which must not trigger the branch, fetch-time and ahead/behind queries of every repo in
   * a large workspace just to name this window's worktree.
   */
  async getWorktreesLight(repo: RepoInfo): Promise<readonly WorktreeEntry[]> {
    if (this.details.has(repo.commonDir)) {
      return this.getWorktrees(repo);
    }
    let pending = this.lightWorktrees.get(repo.commonDir);
    if (pending === undefined) {
      pending = this.deps.getGit().then(async (git) => (await git.worktrees(repo.root)).filter((w) => !w.bare && !w.prunable));
      // A failure is not cached: the next status-bar update retries.
      pending.catch(() => this.lightWorktrees.delete(repo.commonDir));
      this.lightWorktrees.set(repo.commonDir, pending);
    }
    return pending;
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
        case 'stash':
          return this.stashChildren(node.repo, node.stash);
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
        }, isOneOf(node.worktree.path, this.deps.windowFolders()));
      }
      case 'branch': {
        const counts = await this.aheadBehindCounts(node.repo);
        const location = branchLocation(node.ref, await this.getWorktrees(node.repo), this.deps.windowFolders());
        return branchItem(node.repo, node.ref, node.checkedOutIn, location, this.deps.getBase(node.repo), { counts: counts?.byRef.get(node.ref.name), baseLabel: counts?.baseLabel });
      }
      case 'stash':
        return stashItem(node.stash);
      case 'stashFile':
        return stashFileItem(node, this.deps.extensionUri);
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
    const [worktrees, refs, lastFetchedAt, defaultBranch, stashes] = await Promise.all([
      git.worktrees(repo.root),
      git.refs(repo.root),
      git.lastFetchedAt(repo.root),
      git.defaultBranch(repo.root),
      this.loadStashes(git, repo),
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
      defaultBranch,
      stashes,
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
    return (['worktrees', 'branches', 'remotes', 'stashes'] as const).map((group) => ({ kind: 'group', repo, group }));
  }

  private async groupChildren(repo: RepoInfo, group: GroupKind): Promise<RepoTreeNode[]> {
    const details = await this.getDetails(repo);
    if (group === 'stashes') {
      return details.stashes.map((stash) => ({ kind: 'stash', repo, stash }));
    }
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

  // Stashes are cosmetic next to worktrees and branches: a failure leaves the group empty (WARN)
  // rather than failing the whole repo.
  private async loadStashes(git: GitCli, repo: RepoInfo): Promise<StashEntry[]> {
    try {
      return await git.stashes(repo.root);
    } catch (error) {
      this.deps.logger.warn('stashes unavailable', { function: 'loadStashes', repo: repo.name, reason: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  private async stashChildren(repo: RepoInfo, stash: StashEntry): Promise<RepoTreeNode[]> {
    try {
      const files = await stashFiles(await this.deps.getGit(), repo.root, stash);
      return files.length > 0
        ? files.map((entry) => ({ kind: 'stashFile', repo, stash, entry }))
        : [{ kind: 'message', text: 'No file changes', icon: 'info' }];
    } catch (error) {
      this.deps.logger.warn('stash files unavailable', { function: 'stashChildren', repo: repo.name, stash: stash.sha, reason: error instanceof Error ? error.message : String(error) });
      return [{ kind: 'message', text: `Couldn't read this stash: ${error instanceof Error ? error.message : String(error)}`, icon: 'error' }];
    }
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
    // Always say what the one-click compare uses, so neither side of a comparison is ever implicit.
    const against = base !== undefined ? baseLabel(base) : details?.defaultBranch;
    item.description = [main?.branch, against !== undefined ? `against ${against}` : undefined, fetched].filter(Boolean).join(' · ');
    item.tooltip =
      `${repo.root}\nThe compare button reviews against ${against ?? 'the default branch'}${base !== undefined ? ' (set for this repo)' : ' (default branch)'}. Right-click → Change Default Against…` +
      (stale ? '\nNot fetched recently: comparisons with remote branches may be out of date. Right-click → Fetch.' : '');
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
    const labels: Record<GroupKind, string> = { worktrees: 'Worktrees', branches: 'Branches', remotes: 'Remote Branches', stashes: 'Stashes' };
    const icons: Record<GroupKind, string> = { worktrees: 'list-tree', branches: 'git-branch', remotes: 'cloud', stashes: 'archive' };
    const count =
      group === 'worktrees'
        ? details.worktrees.filter((w) => !w.bare && !w.prunable).length
        : group === 'stashes'
          ? details.stashes.length
          : details.refs.filter((r) => r.kind === (group === 'branches' ? 'local' : 'remote')).length;
    // Remote branches and stashes are long or rarely needed; keep them out of the way.
    const state = group === 'remotes' || group === 'stashes' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
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
  inWindow: boolean,
): vscode.TreeItem {
  const label = worktree.branch ?? `detached @ ${(worktree.head ?? '').slice(0, 7)}`;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  const isBase = baseMatches(base, { worktreeRoot: worktree.path });
  item.id = `worktree:${worktree.path}`;
  item.iconPath = new vscode.ThemeIcon(isBase ? 'target' : inWindow ? 'window' : isMain ? 'home' : 'folder');
  const location = isMain ? 'main worktree' : displayPath(repo.root, worktree.path);
  // Age of the latest commit, so the newest-first order is visible.
  const age = committedAt === undefined ? undefined : formatAge(committedAt, Date.now());
  item.description = [isBase ? 'default Against' : undefined, inWindow ? 'this window' : undefined, aheadBehindText(position.counts), location, age]
    .filter(Boolean)
    .join(' · ');
  item.tooltip = withAheadBehindTooltip(`${worktree.path}${inWindow ? '\nOpen in this window.' : '\nOpen… opens it in a new window.'}`, position);
  item.contextValue = `comparable.worktree${isMain ? '.main' : ''}${isBase ? '.base' : ''}`;
  return item;
}

function branchItem(
  repo: RepoInfo,
  ref: RefEntry,
  checkedOutIn: string | undefined,
  location: BranchLocation,
  base: BaseSpec | undefined,
  position: RowAheadBehind,
): vscode.TreeItem {
  const item = new vscode.TreeItem(ref.name, vscode.TreeItemCollapsibleState.None);
  const isBase = baseMatches(base, { ref: ref.name });
  item.id = `branch:${repo.commonDir}:${ref.kind}:${ref.name}`;
  const icon = isBase ? 'target' : location.kind === 'thisWindow' ? 'window' : ref.kind === 'remote' ? 'cloud' : location.kind === 'otherWorktree' ? 'folder' : 'git-branch';
  item.iconPath = new vscode.ThemeIcon(icon);
  // Where it lives comes first: it decides what Open does (branchLocation.ts).
  const where = locationText(location, ref, repo.root);
  const age = ref.committedAt === undefined ? undefined : formatAge(ref.committedAt, Date.now());
  item.description = [isBase ? 'default Against' : undefined, where, aheadBehindText(position.counts), age].filter(Boolean).join(' · ');
  const opens =
    location.kind === 'thisWindow'
      ? 'Checked out in this window.'
      : location.kind === 'otherWorktree'
        ? `Checked out in ${location.worktree.path}. Open… opens that worktree in a new window.`
        : 'Not checked out. Open… lets you switch to it or create a worktree for it.';
  item.tooltip = withAheadBehindTooltip(`${ref.name} @ ${ref.sha}${ref.upstream !== undefined ? ` → ${ref.upstream}` : ''}\n${opens}`, position);
  item.contextValue = `comparable.branch.${ref.kind}${checkedOutIn !== undefined ? '.checkedOut' : ''}${isBase ? '.base' : ''}`;
  return item;
}

function stashItem(stash: StashEntry): vscode.TreeItem {
  const item = new vscode.TreeItem(stashLabel(stash), vscode.TreeItemCollapsibleState.Collapsed);
  item.id = `stash:${stash.sha}`;
  item.description = stashDescription(stash, Date.now());
  item.tooltip = stashTooltip(stash);
  item.iconPath = new vscode.ThemeIcon('archive');
  item.contextValue = 'stash';
  return item;
}

function stashFileItem(node: Extract<RepoTreeNode, { kind: 'stashFile' }>, extensionUri: vscode.Uri): vscode.TreeItem {
  const { file } = node.entry;
  const item = new vscode.TreeItem(path.posix.basename(file.path));
  item.id = `stash:${node.stash.sha}:${file.path}`;
  item.resourceUri = changedFileUri(file, node.repo.commonDir);
  const icon = diffBarIcon(file, extensionUri);
  if (icon !== undefined) {
    item.iconPath = icon;
  }
  const directory = path.posix.dirname(file.path);
  const where = [directory === '.' ? '' : directory, file.status === 'untracked' ? '(untracked)' : ''].filter(Boolean).join(' ');
  item.description = [fileLineStatsText(file.lines), where].filter((part) => part.length > 0).join('  ');
  item.tooltip = file.path;
  item.command = { command: 'gitComparePlus.stash.openFile', title: 'Open Change', arguments: [node] };
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
      return { repo: node.repo, subject: { kind: 'ref', ref: node.ref.name, label: node.ref.name, refKind: node.ref.kind === 'remote' ? 'remote' : 'branch' } };
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
