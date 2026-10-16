/**
 * Git Branch & Worktree Compare — extension entry point.
 *
 * Adds an activity-bar container with two views:
 *   - Repositories: every repo in the window (one or many) with its worktrees and branches.
 *     Inline button: compare with the repo's comparison base (default branch unless the user set
 *     one with "Set as Comparison Base"). Context menu: Compare With…, Set/Clear Comparison Base.
 *   - Changes: three header rows stating exactly what is compared (subject incl./excl. uncommitted
 *     edits, base, mode), each clickable to change it; then the changed files. Clicking a file
 *     opens the diff; "Open All Changes" opens every file in one multi-file diff.
 *
 * Also contributes "Compare All Repos With Default Branch" (every repo's main worktree at once).
 *
 * Wiring only: comparison logic is in comparison.ts, git access in git/gitCli.ts, views in views/.
 * Logs: View → Output → "Git Branch & Worktree Compare" (raise detail with "Developer: Set Log Level…").
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RefType, rankBranchCandidates } from './branchCandidates';
import { BaseStore, baseLabel, baseMatches } from './baseStore';
import {
  baseForcesDirect,
  diffSides,
  runComparisons,
  type BaseSpec,
  type CompareMode,
  type ComparisonRequest,
  type ComparisonResult,
  type RepoInfo,
  type Subject,
} from './comparison';
import { GitActions } from './gitActions';
import { GitCli } from './git/gitCli';
import type { WorktreeEntry } from './git/parsers';
import { createChannelLogger, type Logger } from './logger';
import { formatAge, isFetchStale, selectionTargets } from './operations';
import { discoverRepos, getGitApi } from './repoDiscovery';
import type { BaseFetchInfo, ComparisonSetup } from './views/changesHeader';
import { ChangesProvider, type ChangesNode } from './views/changesView';
import { CONTENT_SCHEME, RevisionContentProvider, sideToUri } from './views/content';
import { RepositoriesProvider, toComparisonTarget, worktreeLabel, type RepoTreeNode } from './views/repositoriesView';

/** Activate: called when the sidebar is opened or a command runs. */
export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('Git Branch & Worktree Compare', { log: true });
  const logger = createChannelLogger(channel, 'BranchCompare');

  // Memoized: the git extension activates asynchronously, and every view/command shares one GitCli.
  let services: Promise<{ git: GitCli; discover: () => Promise<RepoInfo[]> }> | undefined;
  const getServices = () => {
    services ??= getGitApi().then((api) => {
      const git = new GitCli(api.git.path, logger);
      return { git, discover: () => discoverRepos(api, git, logger) };
    });
    // A failed start (git disabled) should be retried on the next action, not cached forever.
    services.catch(() => (services = undefined));
    return services;
  };
  const getGit = async (): Promise<GitCli> => (await getServices()).git;

  const bases = new BaseStore(context.workspaceState);
  const repositories = new RepositoriesProvider({
    getGit,
    discoverRepos: async () => (await getServices()).discover(),
    getBase: (repo) => bases.get(repo.commonDir),
    staleFetchHours: () => settings().staleFetchHours,
    logger,
  });
  // canSelectMany: Delete Branch / Remove Worktree act on the whole selection (one confirmation).
  const repositoriesView = vscode.window.createTreeView('branchCompare.repositories', {
    treeDataProvider: repositories,
    showCollapseAll: true,
    canSelectMany: true,
  });
  const changes = new ChangesProvider();
  const changesView = vscode.window.createTreeView('branchCompare.changes', { treeDataProvider: changes, showCollapseAll: true });
  changes.attach(changesView);

  const commands = new CompareCommands(getGit, repositories, changes, bases, logger);
  const actions = new GitActions({
    getGit,
    repositories,
    changes,
    bases,
    logger,
    compareWorktree: (repo, worktree) => commands.compareNode({ kind: 'worktree', repo, worktree, isMain: false }, 'stored'),
  });

  context.subscriptions.push(
    channel,
    changesView,
    repositoriesView,
    vscode.window.registerFileDecorationProvider(changes),
    vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, new RevisionContentProvider(getGit, logger)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => repositories.refresh()),
    register('branchCompare.refresh', () => repositories.refresh()),
    register('branchCompare.compareAll', () => commands.compareAll(), logger),
    register('branchCompare.compare', (node?: RepoTreeNode) => commands.compareNode(node, 'stored'), logger),
    register('branchCompare.compareWith', (node?: RepoTreeNode) => commands.compareNode(node, 'pick'), logger),
    register('branchCompare.setBase', (node: RepoTreeNode) => commands.setBase(node), logger),
    register('branchCompare.clearBase', (node: RepoTreeNode) => commands.clearBase(node), logger),
    register('branchCompare.openWorktree', (node: RepoTreeNode) => commands.openWorktree(node), logger),
    register('branchCompare.openChange', (node: ChangesNode) => commands.openChange(node), logger),
    register('branchCompare.openAllChanges', () => commands.openAllChanges(), logger),
    register('branchCompare.rerun', () => commands.rerun(), logger),
    register('branchCompare.changeBase', () => commands.changeBase(), logger),
    register('branchCompare.toggleUncommitted', () => commands.toggleUncommitted(), logger),
    register('branchCompare.toggleMode', () => commands.toggleMode(), logger),
    register('branchCompare.clear', () => changes.clear()),
    register('branchCompare.fetch', (node?: RepoTreeNode) => actions.fetchRepo(node), logger),
    register('branchCompare.fetchAll', () => actions.fetchAll(), logger),
    register('branchCompare.fetchAndRerun', () => commands.fetchAndRerun(actions), logger),
    register('branchCompare.createWorktree', (node?: RepoTreeNode) => actions.createWorktree(node), logger),
    register('branchCompare.removeWorktree', (node?: RepoTreeNode, selection?: RepoTreeNode[]) => actions.removeWorktrees(selectionTargets(node, selection)), logger),
    register('branchCompare.createBranch', (node?: RepoTreeNode) => actions.createBranch(node), logger),
    register('branchCompare.deleteBranch', (node?: RepoTreeNode, selection?: RepoTreeNode[]) => actions.deleteBranches(selectionTargets(node, selection)), logger),
    // Delete key: keybindings pass no arguments, so read the tree's own selection.
    register('branchCompare.deleteSelected', () => actions.deleteSelection(repositoriesView.selection), logger),
    register('branchCompare.switchBranch', (node?: RepoTreeNode) => actions.switchBranch(node), logger),
  );
}

/** Nothing to clean up beyond `context.subscriptions`. */
export function deactivate(): void {}

/**
 * Register a command whose failures are logged (at the top of the command, the only place that
 * knows which user action failed) and shown to the user instead of vanishing.
 */
function register<A extends unknown[]>(id: string, handler: (...args: A) => unknown, logger?: Logger): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (...args: A) => {
    try {
      await handler(...args);
    } catch (error) {
      logger?.error('command failed', error, { function: 'register', command: id });
      void vscode.window.showErrorMessage(`Git Branch & Worktree Compare: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** User settings read at the start of each comparison. */
function settings(): { includeUntracked: boolean; includeUncommitted: boolean; mode: CompareMode; staleFetchHours: number } {
  const config = vscode.workspace.getConfiguration('branchCompare');
  return {
    staleFetchHours: config.get<number>('staleFetchHours', 24),
    includeUntracked: config.get<boolean>('includeUntracked', true),
    includeUncommitted: config.get<boolean>('includeUncommitted', true),
    mode: config.get<string>('compareMode', 'sinceBranchPoint') === 'allDifferences' ? 'direct' : 'merge-base',
  };
}

interface BasePickItem extends vscode.QuickPickItem {
  readonly base?: BaseSpec;
  /** Set for worktree items: the uncommitted-edits question is asked after picking. */
  readonly worktree?: WorktreeEntry;
}

/** Command implementations. State lives in the views and the base store. */
class CompareCommands {
  constructor(
    private readonly getGit: () => Promise<GitCli>,
    private readonly repositories: RepositoriesProvider,
    private readonly changes: ChangesProvider,
    private readonly bases: BaseStore,
    private readonly logger: Logger,
  ) {}

  /** Compare every repo's main worktree with its own default branch. */
  async compareAll(): Promise<void> {
    const repos = await this.repositories.getRepos();
    if (repos.length === 0) {
      void vscode.window.showInformationMessage('No git repositories in this window.');
      return;
    }
    const git = await this.getGit();
    const { includeUncommitted, mode } = settings();
    const requests = await Promise.all(
      repos.map(async (repo): Promise<ComparisonRequest> => {
        const branch = (await git.worktrees(repo.root))[0]?.branch;
        return { repo, subject: { kind: 'worktree', root: repo.root, label: branch ?? repo.name, includeUncommitted } };
      }),
    );
    await this.run({ requests, base: { kind: 'default' }, mode });
  }

  /**
   * Compare one Repositories item. `stored` uses the repo's comparison base (default branch unless
   * set); `pick` asks which branch or worktree to compare with.
   */
  async compareNode(node: RepoTreeNode | undefined, base: 'stored' | 'pick'): Promise<void> {
    // From the Command Palette there is no node; point the user at the view.
    if (node === undefined) {
      await vscode.commands.executeCommand('branchCompare.repositories.focus');
      return;
    }
    const git = await this.getGit();
    const { includeUncommitted, mode } = settings();
    const mainBranch = node.kind === 'repo' ? (await git.worktrees(node.repo.root))[0]?.branch : undefined;
    const target = toComparisonTarget(node, mainBranch, includeUncommitted);
    if (target === undefined) {
      return;
    }
    const baseSpec = base === 'stored' ? (this.bases.get(target.repo.commonDir) ?? { kind: 'default' as const }) : await this.pickBaseForRepo(target.repo, target.subject);
    // Undefined = the picker was dismissed.
    if (baseSpec === undefined) {
      return;
    }
    if (isSameSide(target.subject, baseSpec)) {
      void vscode.window.showInformationMessage(`${target.subject.label} is the comparison base. Use Compare With… to pick something else.`);
      return;
    }
    await this.run({ requests: [target], base: baseSpec, mode });
  }

  /** "Set as Comparison Base": the inline compare button of this repo will use it until cleared. */
  async setBase(node: RepoTreeNode): Promise<void> {
    let base: BaseSpec | undefined;
    if (node.kind === 'worktree') {
      base = await this.worktreeBase(node.worktree);
    } else if (node.kind === 'branch') {
      base = { kind: 'ref', ref: node.ref.name };
    }
    if (base === undefined || (node.kind !== 'worktree' && node.kind !== 'branch')) {
      return;
    }
    await this.bases.set(node.repo.commonDir, base);
    this.logger.info('comparison base set', { function: 'setBase', repo: node.repo.name, base });
    this.repositories.redraw();
  }

  /** Back to the repo's default branch. */
  async clearBase(node: RepoTreeNode): Promise<void> {
    if (node.kind === 'message') {
      return;
    }
    await this.bases.clear(node.repo.commonDir);
    this.logger.info('comparison base cleared', { function: 'clearBase', repo: node.repo.name });
    this.repositories.redraw();
  }

  /** Open a worktree folder in a new window. */
  async openWorktree(node: RepoTreeNode): Promise<void> {
    if (node.kind === 'worktree') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), { forceNewWindow: true });
    }
  }

  /** Open the diff editor for one changed file. */
  async openChange(node: ChangesNode): Promise<void> {
    if (node.kind !== 'file') {
      return;
    }
    const { result, file } = node;
    const sides = diffSides(result, file);
    const title = `${path.posix.basename(file.path)} (${result.baseLabel ?? 'base'} ↔ ${subjectTitle(result.subject)})`;
    await vscode.commands.executeCommand('vscode.diff', sideToUri(sides.left, file.oldPath), sideToUri(sides.right, file.path), title, { preview: true });
  }

  /** Open every file of the current comparison in one multi-file diff editor. */
  async openAllChanges(): Promise<void> {
    const nodes = this.changes.allFileNodes();
    const first = nodes[0];
    if (first === undefined) {
      return;
    }
    const entries = nodes.map(({ result, file }) => {
      const { left, right } = diffSides(result, file);
      const leftUri = left.kind === 'empty' ? undefined : sideToUri(left, file.oldPath);
      const rightUri = right.kind === 'empty' ? undefined : sideToUri(right, file.path);
      // First element labels the entry; prefer the subject side, which exists unless deleted.
      return [rightUri ?? leftUri, leftUri, rightUri];
    });
    const title = nodes.every((n) => n.result === first.result)
      ? `${first.result.baseLabel ?? 'base'} ↔ ${subjectTitle(first.result.subject)}`
      : 'All repos ↔ base';
    await vscode.commands.executeCommand('vscode.changes', title, entries);
  }

  /** Recompute the comparison on display (edits since, new commits, a fresh base snapshot). */
  async rerun(): Promise<void> {
    const state = this.changes.current();
    if (state !== undefined) {
      await this.run(state.setup);
    }
  }

  /** Changes title bar: fetch the repos in the current comparison, then re-run it. */
  async fetchAndRerun(actions: GitActions): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    await actions.fetchRepos([...new Map(state.setup.requests.map((r) => [r.repo.commonDir, r.repo])).values()]);
    await this.run(state.setup);
  }

  /** Header row "With: …": pick a different base for the comparison on display. */
  async changeBase(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    const only = state.setup.requests.length === 1 ? state.setup.requests[0] : undefined;
    const base = only !== undefined ? await this.pickBaseForRepo(only.repo, only.subject) : await this.pickBaseAcrossRepos(state.setup.requests);
    if (base !== undefined) {
      await this.run({ ...state.setup, base });
    }
  }

  /** Header row "Comparing: …": include / exclude the subject worktree's uncommitted edits. */
  async toggleUncommitted(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    const worktrees = state.setup.requests.filter((r) => r.subject.kind === 'worktree');
    const allIncluded = worktrees.every((r) => r.subject.kind === 'worktree' && r.subject.includeUncommitted);
    const requests = state.setup.requests.map((r): ComparisonRequest =>
      r.subject.kind === 'worktree' ? { ...r, subject: { ...r.subject, includeUncommitted: !allIncluded } } : r,
    );
    await this.run({ ...state.setup, requests });
  }

  /** Header row "Showing: …": switch between changes since the branch point and all differences. */
  async toggleMode(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    if (baseForcesDirect(state.setup.base)) {
      void vscode.window.showInformationMessage(
        'The base includes uncommitted edits, which have no branch point. Change the base to its committed state to compare since the branch point.',
      );
      return;
    }
    await this.run({ ...state.setup, mode: state.setup.mode === 'merge-base' ? 'direct' : 'merge-base' });
  }

  private async run(setup: ComparisonSetup): Promise<void> {
    const git = await this.getGit();
    const { includeUntracked } = settings();
    const results: ComparisonResult[] = await vscode.window.withProgress(
      { location: { viewId: 'branchCompare.changes' }, title: 'Comparing…' },
      () => runComparisons(git, setup.requests, setup.base, setup.mode, { includeUntracked, logger: this.logger }),
    );
    this.changes.show({ setup, results, baseFetch: await this.baseFetchInfo(results) });
    await vscode.commands.executeCommand('branchCompare.changes.focus');
  }

  /**
   * Freshness of the base when it is a remote-tracking branch in at least one repo: the OLDEST
   * last-fetch among those repos, since one stale repo is enough to skew the view.
   */
  private async baseFetchInfo(results: readonly ComparisonResult[]): Promise<BaseFetchInfo | undefined> {
    const remoteBased = await Promise.all(
      results.map(async (r) => {
        const refs = await this.repositories.getRefs(r.repo);
        return refs.some((ref) => ref.kind === 'remote' && ref.name === r.baseLabel) ? r.repo : undefined;
      }),
    );
    const repos = remoteBased.filter((r): r is RepoInfo => r !== undefined);
    if (repos.length === 0) {
      return undefined;
    }
    const fetchedAt = await Promise.all(repos.map((repo) => this.repositories.getLastFetchedAt(repo)));
    // `undefined` (never fetched) is the stalest possible value.
    const oldest = fetchedAt.includes(undefined) ? undefined : Math.min(...fetchedAt.filter((t): t is number => t !== undefined));
    const now = Date.now();
    return { age: formatAge(oldest, now), stale: isFetchStale(oldest, now, settings().staleFetchHours) };
  }

  /** Base picker for one repo: default branch, its other worktrees, its branches, or a typed ref. */
  private async pickBaseForRepo(repo: RepoInfo, subject: Subject): Promise<BaseSpec | undefined> {
    const git = await this.getGit();
    const [defaultBranch, refs, worktrees] = await Promise.all([
      git.defaultBranch(repo.root),
      this.repositories.getRefs(repo),
      this.repositories.getWorktrees(repo),
    ]);
    const stored = this.bases.get(repo.commonDir);
    const otherWorktrees = worktrees.filter((w) => !(subject.kind === 'worktree' && w.path === subject.root));
    // `refs` arrive in display order (treeOrder.ts: default branch, main/master, newest first),
    // the same order as the Repositories view.
    const branches = refs.filter((r) => !(subject.kind === 'ref' && r.name === subject.ref));

    const items: BasePickItem[] = [
      { label: '$(star-full) Default branch', description: defaultBranch ?? 'not found', base: { kind: 'default' } },
      ...(stored !== undefined ? [{ label: '$(target) Comparison base set for this repo', description: baseLabel(stored), base: stored }] : []),
      ...(otherWorktrees.length > 0 ? [{ label: 'Worktrees', kind: vscode.QuickPickItemKind.Separator }] : []),
      ...otherWorktrees.map((w) => ({ label: `$(folder) ${worktreeLabel(w)}`, description: w.path, worktree: w })),
      { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
      ...branches.map((r) => ({
        label: `$(${r.kind === 'remote' ? 'cloud' : 'git-branch'}) ${r.name}`,
        description: r.committedAt === undefined ? undefined : formatAge(r.committedAt, Date.now()),
        base: { kind: 'ref' as const, ref: r.name },
      })),
    ];
    const picked = await pickWithFreeText(items, `Compare ${subject.label} with…`);
    if (picked?.worktree !== undefined) {
      return this.worktreeBase(picked.worktree);
    }
    return picked?.base;
  }

  /** Base picker for a multi-repo comparison: default branches, or a branch name shared across repos. */
  private async pickBaseAcrossRepos(requests: readonly ComparisonRequest[]): Promise<BaseSpec | undefined> {
    const refLists = await Promise.all(requests.map((r) => this.repositories.getRefs(r.repo)));
    const candidates = rankBranchCandidates(
      refLists.map((refs) => refs.map((r) => ({ type: r.kind === 'local' ? RefType.Head : RefType.RemoteHead, name: r.name }))),
    );
    const items: BasePickItem[] = [
      { label: "$(star-full) Each repo's default branch", description: 'origin/HEAD per repo', base: { kind: 'default' } },
      { label: 'Branches', kind: vscode.QuickPickItemKind.Separator },
      ...candidates.map((c) => ({
        label: `$(git-branch) ${c.ref}`,
        description: `in ${c.repoCount} of ${requests.length} repos`,
        base: { kind: 'ref' as const, ref: c.ref },
      })),
    ];
    return (await pickWithFreeText(items, 'Compare all repos with…'))?.base;
  }

  /** Ask whether a worktree base includes its uncommitted edits, showing how many there are. */
  private async worktreeBase(worktree: WorktreeEntry): Promise<BaseSpec | undefined> {
    const git = await this.getGit();
    const count = await git.uncommittedCount(worktree.path, settings().includeUntracked);
    const label = worktreeLabel(worktree);
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(edit) Include its uncommitted edits',
          description: count > 0 ? `${count} uncommitted file${count === 1 ? '' : 's'} right now` : 'none right now',
          detail: 'Compares with the files on disk in that worktree (snapshot taken each time the comparison runs). Shows all differences.',
          include: true,
        },
        {
          label: '$(git-commit) Committed only',
          description: count > 0 ? `${count} uncommitted file${count === 1 ? '' : 's'} will NOT be included` : 'nothing uncommitted right now',
          detail: "Compares with that worktree's last commit (HEAD). Allows comparing since the branch point.",
          include: false,
        },
      ],
      { title: `Compare with worktree ${label}: include its uncommitted edits?` },
    );
    return choice === undefined ? undefined : { kind: 'worktree', root: worktree.path, label, includeUncommitted: choice.include };
  }
}

/** Quick pick where Enter on text that matches nothing uses the text as a ref (tag, SHA, …). */
function pickWithFreeText(items: readonly BasePickItem[], title: string): Promise<BasePickItem | undefined> {
  const quickPick = vscode.window.createQuickPick<BasePickItem>();
  quickPick.title = title;
  quickPick.placeholder = 'Pick a branch or worktree, or type any ref (branch, tag, SHA) and press Enter';
  quickPick.matchOnDescription = true;
  quickPick.items = items;
  return new Promise<BasePickItem | undefined>((resolve) => {
    let settled = false;
    quickPick.onDidAccept(() => {
      settled = true;
      const typed = quickPick.value.trim();
      const selected = quickPick.selectedItems[0];
      resolve(selected ?? (typed.length > 0 ? { label: typed, base: { kind: 'ref', ref: typed } } : undefined));
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      if (!settled) {
        resolve(undefined);
      }
      quickPick.dispose();
    });
    quickPick.show();
  });
}

/** True when the base IS the subject (comparing something with itself). */
function isSameSide(subject: Subject, base: BaseSpec): boolean {
  return subject.kind === 'worktree' ? baseMatches(base, { worktreeRoot: subject.root }) : baseMatches(base, { ref: subject.ref });
}

/** Subject name for diff titles; "committed" makes a HEAD-only worktree comparison explicit. */
function subjectTitle(subject: Subject): string {
  return subject.kind === 'worktree' && !subject.includeUncommitted ? `${subject.label}, committed` : subject.label;
}
