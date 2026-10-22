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
import { ChangesAutoRefresh } from './autoRefresh/changesAutoRefresh';
import { BlameController } from './blame/blameController';
import { CommitActions } from './commits/commitActions';
import type { CommitTarget } from './commits/commitTarget';
import { CommitsView, type CommitsNode } from './commits/commitsView';
import { HistoryController, type HistoryNode } from './history/historyView';
import { followGitChanges } from './autoRefresh/gitEvents';
import { stableSignature } from './autoRefresh/scheduling';
import { RefType, rankBranchCandidates } from './branchCandidates';
import { BaseStore, baseMatches } from './baseStore';
import {
  baseForcesDirect,
  diffSides,
  subjectCwd,
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
import { parseDefaultBranchSettings } from './defaultBranch';
import { discoverRepos, getGitApi, type GitApi } from './repoDiscovery';
import { ReviewStore } from './review/reviewStore';
import { groupReviewToggles } from './review/reviewToggles';
import type { BaseFetchInfo, ComparisonSetup } from './views/changesHeader';
import { sideChoices, type SideRole, type SideValue } from './sideChoices';
import { swapSides } from './swapSides';
import { pickSide } from './views/sidePicker';
import { WorktreeStatus } from './views/worktreeStatus';
import { ChangesProvider, type ChangesLayout, type ChangesNode } from './views/changesView';
import { commitTitle } from './views/commitText';
import { multiDiffEntries, openCommitChanges } from './views/commitDiff';
import { CONTENT_SCHEME, RevisionContentProvider, sideToUri } from './views/content';
import { RepositoriesProvider, toComparisonTarget, worktreeLabel, type RepoTreeNode } from './views/repositoriesView';

/** What `activate` returns; read by the extension-host smoke test (test/host/suite.cjs). */
export interface ExtensionApi {
  /** How long `activate` itself took, ms. */
  readonly activationMs: number;
}

/**
 * Activate: once the editor has finished starting (`onStartupFinished`), so blame is ready when a
 * file is opened without delaying startup; or earlier if a view or command is used first.
 */
export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const startedAt = Date.now();
  const channel = vscode.window.createOutputChannel('Git Branch & Worktree Compare', { log: true });
  const logger = createChannelLogger(channel, 'BranchCompare');

  // Memoized: the git extension activates asynchronously, and every view/command shares one GitCli.
  let services: Promise<{ api: GitApi; git: GitCli; discover: () => Promise<RepoInfo[]> }> | undefined;
  const getServices = () => {
    services ??= getGitApi().then((api) => {
      const git = new GitCli(api.git.path, logger, () => {
        const config = vscode.workspace.getConfiguration('branchCompare');
        return parseDefaultBranchSettings(config.get('remote'), config.get('defaultBranches'));
      });
      return { api, git, discover: () => discoverRepos(api, git, logger) };
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
    extensionUri: context.extensionUri,
    windowFolders: () => windowFolders(),
    onPersistentFailure: (repoName, reason) =>
      void notifyPersistentFailure(`the ${repoName} repository`, reason, channel, [
        { title: 'Refresh', run: () => repositories.refresh() },
      ]),
    logger,
  });
  // canSelectMany: Delete Branch / Remove Worktree act on the whole selection (one confirmation).
  const repositoriesView = vscode.window.createTreeView('branchCompare.repositories', {
    treeDataProvider: repositories,
    showCollapseAll: true,
    canSelectMany: true,
  });
  repositories.attach(repositoriesView);
  const reviews = new ReviewStore(context.workspaceState);
  const changes = new ChangesProvider(
    (result, file) => reviews.isReviewed(result.repo.commonDir, file.path, file.fingerprint),
    context.extensionUri,
    () => settings().changesLayout,
  );
  // Drives which of View as Tree / View as List the Changes title bar shows.
  void vscode.commands.executeCommand('setContext', 'branchCompare.changesLayout', settings().changesLayout);
  // manageCheckboxStateManually: only file rows have checkboxes; repo rows must not cascade.
  const changesView = vscode.window.createTreeView('branchCompare.changes', {
    treeDataProvider: changes,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
    // Compare These Two on two commits of the Commits group.
    canSelectMany: true,
  });
  changes.attach(changesView);

  const commands = new CompareCommands(getGit, repositories, changes, bases, logger);
  const actions = new GitActions({
    getGit,
    repositories,
    changes,
    bases,
    logger,
    compareWorktree: (repo, worktree) => commands.compareNode({ kind: 'worktree', repo, worktree, isMain: false }, 'stored'),
    windowFolders: () => windowFolders(),
  });

  const goTo = new WorktreeStatus(repositories, actions, () => windowFolders(), logger);
  const blame = new BlameController(getGit, () => blameSettings(), logger);
  // The repo a worktree root belongs to (History and Commits rows carry only the root).
  const repoFor = async (root: string): Promise<RepoInfo | undefined> => {
    const git = await getGit();
    const [repos, commonDir] = await Promise.all([repositories.getRepos(), git.commonDir(root)]);
    return repos.find((repo) => repo.commonDir === commonDir);
  };
  const history = new HistoryController({
    getGit,
    repoFor: (root) => repoFor(root),
    pickAgainst: (repo, title) => commands.pickAgainst(repo, undefined, title),
    logger,
  });

  const commitsView = new CommitsView({
    getGit,
    pickRepository: async () => {
      const picked = await pickRepository(await repositories.getRepos(), false);
      return picked === 'all' ? undefined : picked;
    },
    extensionUri: context.extensionUri,
    logger,
  });
  const commitActions = new CommitActions({
    getGit,
    resolve: (node) => resolveCommitTarget(node, repoFor),
    showDetails: (target) => commitsView.showCommit(target),
    pickAgainst: (repo, reviewing, title) => commands.pickAgainst(repo, reviewing, title),
    review: (setup) => commands.review(setup),
    settings: () => settings(),
    logger,
  });

  context.subscriptions.push(
    commitsView,
    commitActions,
    history,
    blame,
    goTo,
    channel,
    changesView,
    repositoriesView,
    vscode.window.registerFileDecorationProvider(changes),
    changesView.onDidChangeCheckboxState((event) => void markReviewed(event.items, reviews, changes, logger)),
    vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, new RevisionContentProvider(getGit, logger)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      repositories.refresh();
      void goTo.update();
    }),
    register('branchCompare.refresh', () => repositories.refresh()),
    register('branchCompare.compareAll', () => commands.compareAll(), logger),
    register('branchCompare.compare', (node?: RepoTreeNode) => commands.compareNode(node, 'stored'), logger),
    register('branchCompare.compareWith', (node?: RepoTreeNode) => commands.compareNode(node, 'pick'), logger),
    register('branchCompare.setBase', (node: RepoTreeNode) => commands.setBase(node), logger),
    register('branchCompare.clearBase', (node: RepoTreeNode) => commands.clearBase(node), logger),
    register('branchCompare.openWorktree', (node: RepoTreeNode) => commands.openWorktree(node), logger),
    register('branchCompare.openChange', (node: ChangesNode) => commands.openChange(node), logger),
    register('branchCompare.openAllChanges', () => commands.openAllChanges(), logger),
    register('branchCompare.viewAsTree', () => setChangesLayout('tree'), logger),
    register('branchCompare.viewAsList', () => setChangesLayout('list'), logger),
    register('branchCompare.swapSides', () => commands.swapSides(), logger),
    register('branchCompare.compareTwo', () => commands.compareTwo(), logger),
    register('branchCompare.changeSubject', () => commands.changeSubject(), logger),
    register('branchCompare.changeDefaultBase', (node?: RepoTreeNode) => commands.changeDefaultBase(node), logger),
    register('branchCompare.openFile', (node: ChangesNode) => commands.openFileSide(node, 'right'), logger),
    register('branchCompare.openFileAtBase', (node: ChangesNode) => commands.openFileSide(node, 'left'), logger),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // The default branch drives ordering, ahead/behind and the one-click compare: reload.
      if (event.affectsConfiguration('branchCompare.remote') || event.affectsConfiguration('branchCompare.defaultBranches')) {
        repositories.refresh();
      }
      if (event.affectsConfiguration('branchCompare.blame')) {
        blame.settingsChanged();
      }
      if (event.affectsConfiguration('branchCompare.changesLayout')) {
        void vscode.commands.executeCommand('setContext', 'branchCompare.changesLayout', settings().changesLayout);
        changes.redraw();
      }
    }),
    register('branchCompare.openCommit', (node: ChangesNode) => commands.openCommit(node), logger),
    register('branchCompare.compareWithCommit', (node: ChangesNode) => commands.compareWithCommit(node), logger),
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
    ...startAutoRefresh(getServices, repositories, repositoriesView, changes, commands, () => {
      // A commit or checkout changes what every line blames to and every file's history.
      blame.gitChanged();
      history.gitChanged();
    }, channel, logger),
    register('branchCompare.openBranch', (node?: RepoTreeNode) => actions.openBranch(node), logger),
    register('branchCompare.stash.apply', (node?: RepoTreeNode) => actions.applyStash(node, 'apply'), logger),
    register('branchCompare.stash.pop', (node?: RepoTreeNode) => actions.applyStash(node, 'pop'), logger),
    register('branchCompare.stash.drop', (node?: RepoTreeNode) => actions.dropStash(node), logger),
    register('branchCompare.stash.openFile', (node?: RepoTreeNode) => actions.openStashFile(node), logger),
    register('branchCompare.stash.openAll', (node?: RepoTreeNode) => actions.openStashChanges(node), logger),
    register('branchCompare.goTo', () => goTo.pick(), logger),
    register('branchCompare.switchBranch', (node?: RepoTreeNode) => actions.switchBranch(node), logger),
  );
  return { activationMs: Date.now() - startedAt };
}

// Commits offered by "Search commits…": enough to reach back a few weeks on a busy repo while
// keeping the list instant to filter. Older commits can still be pasted by ID.
const RECENT_COMMITS_LIMIT = 500;

// Re-render relative ages ("3 h ago", fetch staleness) once a minute. Redraw only, no git commands.
const AGE_REFRESH_MS = 60_000;

/**
 * Automatic refresh (see src/autoRefresh/):
 *   - Repositories follows Cursor's git change events (always on; reloads redraw only on change).
 *   - Changes re-runs on file/git changes while `branchCompare.autoRefresh` is on.
 *   - Ages re-render every minute. Fetching is never automatic: it hits the network with your
 *     credentials, so it stays a button.
 * @returns disposables for the extension context.
 */
function startAutoRefresh(
  getServices: () => Promise<{ api: GitApi; git: GitCli }>,
  repositories: RepositoriesProvider,
  repositoriesView: vscode.TreeView<RepoTreeNode>,
  changes: ChangesProvider,
  commands: CompareCommands,
  onGitChange: () => void,
  channel: vscode.LogOutputChannel,
  logger: Logger,
): vscode.Disposable[] {
  const changesRefresh = new ChangesAutoRefresh(
    changes,
    () => commands.rerunQuietly(),
    () => settings().autoRefresh,
    (reason) =>
      void notifyPersistentFailure('the comparison', reason, channel, [
        {
          title: 'Turn Off Auto-Refresh',
          run: () => vscode.workspace.getConfiguration('branchCompare').update('autoRefresh', false, vscode.ConfigurationTarget.Global),
        },
      ]),
    logger,
  );

  let gitSubscription: vscode.Disposable | undefined;
  let disposed = false;
  getServices().then(
    ({ api, git }) => {
      // The extension may have been deactivated while the git extension was still starting.
      if (disposed) {
        return;
      }
      gitSubscription = followGitChanges(
        api,
        git,
        {
          repoChanged: (commonDir) => {
            void repositories.refreshRepoIfChanged(commonDir);
            changesRefresh.repoChanged(commonDir);
            onGitChange();
          },
          reposChanged: () => repositories.refresh(),
        },
        logger,
      );
    },
    (error: unknown) =>
      // Git unavailable (disabled/missing): views show their own error; nothing to follow.
      logger.warn('automatic refresh not started: git extension unavailable', {
        function: 'startAutoRefresh',
        reason: error instanceof Error ? error.message : String(error),
      }),
  );

  const ageTimer = setInterval(() => {
    if (repositoriesView.visible) {
      repositories.redraw();
    }
    repositories.refreshMessage();
    changesRefresh.refreshMessage();
    void commands.refreshAges();
  }, AGE_REFRESH_MS);

  return [
    changesRefresh,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('branchCompare.autoRefresh')) {
        changesRefresh.settingChanged();
      }
    }),
    new vscode.Disposable(() => {
      disposed = true;
      clearInterval(ageTimer);
      gitSubscription?.dispose();
    }),
  ];
}

/**
 * The one popup for a failure episode that persists (failureTracker.ts decides when). Non-modal;
 * offers the log plus a context-specific fix. Momentary failures never get here: they only show
 * in the view's message bar.
 */
async function notifyPersistentFailure(
  scope: string,
  reason: string,
  channel: vscode.LogOutputChannel,
  extraActions: readonly { title: string; run: () => unknown }[],
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Git Branch & Worktree Compare: automatic refresh of ${scope} keeps failing: ${reason}. The view is showing earlier results.`,
    'Show Log',
    ...extraActions.map((a) => a.title),
  );
  if (choice === 'Show Log') {
    channel.show();
    return;
  }
  await extraActions.find((a) => a.title === choice)?.run();
}

/**
 * Store the reviewed marks the user just toggled in Changes, then redraw (counts, and reverting a
 * checkbox that could not be marked). The mark is pinned to the fingerprint of the version that
 * was on screen; if the file has changed since, the next automatic refresh shows it unreviewed.
 */
async function markReviewed(
  items: ReadonlyArray<readonly [ChangesNode, vscode.TreeItemCheckboxState]>,
  reviews: ReviewStore,
  changes: ChangesProvider,
  logger: Logger,
): Promise<void> {
  const toggles = items.flatMap(([node, state]) =>
    node.kind === 'file'
      ? [{ commonDir: node.result.repo.commonDir, path: node.file.path, fingerprint: node.file.fingerprint, checked: state === vscode.TreeItemCheckboxState.Checked }]
      : [],
  );
  const { byRepo, unmarkable } = groupReviewToggles(toggles);
  const now = Date.now();
  try {
    for (const [commonDir, marks] of byRepo) {
      await reviews.set(commonDir, marks.reviewed, true, now);
      await reviews.set(commonDir, marks.unreviewed, false, now);
    }
    logger.info('reviewed marks changed', {
      function: 'markReviewed',
      repos: [...byRepo].map(([commonDir, marks]) => ({ commonDir, reviewed: marks.reviewed.map((m) => m.path), unreviewed: marks.unreviewed.map((m) => m.path) })),
      unmarkable,
    });
  } catch (error) {
    logger.error('saving reviewed marks failed', error, { function: 'markReviewed', toggles });
    void vscode.window.showErrorMessage(`Git Branch & Worktree Compare: couldn't save reviewed marks: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Always redraw: on success to update the counts, otherwise to put the checkboxes back.
    changes.redraw();
  }
  if (unmarkable.length > 0) {
    void vscode.window.showInformationMessage(
      `Can't mark ${unmarkable.length === 1 ? unmarkable[0] : `${unmarkable.length} files`} as reviewed: the content couldn't be read. Refresh the comparison and try again.`,
    );
  }
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

/**
 * Title-bar layout toggle. Saved as a user setting (not per workspace): it is a reading preference.
 * The configuration listener redraws the view and updates the title-bar context key.
 */
async function setChangesLayout(layout: ChangesLayout): Promise<void> {
  await vscode.workspace.getConfiguration('branchCompare').update('changesLayout', layout, vscode.ConfigurationTarget.Global);
}

/** Which blame surfaces are on (`branchCompare.blame.*`). */
function blameSettings(): { currentLine: boolean; statusBar: boolean } {
  const config = vscode.workspace.getConfiguration('branchCompare.blame');
  return { currentLine: config.get<boolean>('currentLine', true), statusBar: config.get<boolean>('statusBar', true) };
}

/** User settings read at the start of each comparison. */
function settings(): {
  includeUntracked: boolean;
  includeUncommitted: boolean;
  mode: CompareMode;
  staleFetchHours: number;
  autoRefresh: boolean;
  changesLayout: ChangesLayout;
} {
  const config = vscode.workspace.getConfiguration('branchCompare');
  return {
    changesLayout: config.get<string>('changesLayout', 'list') === 'tree' ? 'tree' : 'list',
    autoRefresh: config.get<boolean>('autoRefresh', true),
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
    const baseSpec =
      base === 'stored'
        ? (this.bases.get(target.repo.commonDir) ?? { kind: 'default' as const })
        : await this.pickAgainst(target.repo, target.subject, `Review ${target.subject.label} against…`);
    // Undefined = the picker was dismissed.
    if (baseSpec === undefined) {
      return;
    }
    if (isSameSide(target.subject, baseSpec)) {
      void vscode.window.showInformationMessage(`${target.subject.label} is this repo's default Against, so there is nothing to compare. Right-click → Compare With… to pick something else.`);
      return;
    }
    await this.run({ requests: [target], base: baseSpec, mode });
  }

  /**
   * "Compare…": the two questions in order (what to review, then what to compare it against),
   * after picking the repo when the window has several. "All repositories" runs Compare All.
   */
  async compareTwo(): Promise<void> {
    const repos = await this.repositories.getRepos();
    const repo = await pickRepository(repos);
    if (repo === 'all') {
      await this.compareAll();
      return;
    }
    if (repo === undefined) {
      return;
    }
    const subject = await this.pickReviewing(repo, 'Compare (1 of 2): what do you want to review?');
    if (subject === undefined) {
      return;
    }
    const base = await this.pickAgainst(repo, subject, `Compare (2 of 2): review ${subject.label} against…`);
    if (base === undefined) {
      return;
    }
    this.logger.info('comparison picked', { function: 'compareTwo', repo: repo.name, subject, base });
    await this.run({ requests: [{ repo, subject }], base, mode: settings().mode });
  }

  /** Header "Reviewing" row → Change: pick what to review instead, keeping the Against side. */
  async changeSubject(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    const only = state.setup.requests.length === 1 ? state.setup.requests[0] : undefined;
    if (only === undefined) {
      void vscode.window.showInformationMessage('Several repositories are compared. Use Compare… to review something else in one of them.');
      return;
    }
    const subject = await this.pickReviewing(only.repo, `Review instead of ${only.subject.label}…`);
    if (subject === undefined) {
      return;
    }
    if (isSameSide(subject, state.setup.base)) {
      void vscode.window.showInformationMessage(`${subject.label} is what it is compared against. Pick something else, or use ⇄ to swap the sides.`);
      return;
    }
    await this.run({ ...state.setup, requests: [{ repo: only.repo, subject }] });
  }

  /** Repo row → "Change Default Against…": what this repo's one-click compare uses. */
  async changeDefaultBase(node: RepoTreeNode | undefined): Promise<void> {
    if (node === undefined || node.kind !== 'repo') {
      await vscode.commands.executeCommand('branchCompare.repositories.focus');
      return;
    }
    const base = await this.pickAgainst(node.repo, undefined, `${node.repo.name}: compare against what by default?`);
    if (base === undefined) {
      return;
    }
    await this.bases.set(node.repo.commonDir, base);
    this.logger.info('default against changed', { function: 'changeDefaultBase', repo: node.repo.name, base });
    // Reload, not just redraw: the ahead/behind counts on every row are relative to it.
    this.repositories.refreshRepo(node.repo);
  }

  /** "Use as Default Against": the inline compare button of this repo uses it until reset. */
  async setBase(node: RepoTreeNode): Promise<void> {
    let base: BaseSpec | undefined;
    if (node.kind === 'worktree') {
      base = await this.worktreeBase(node.worktree);
    } else if (node.kind === 'branch') {
      base = { kind: 'ref', ref: node.ref.name, refKind: node.ref.kind === 'remote' ? 'remote' : 'branch' };
    }
    if (base === undefined || (node.kind !== 'worktree' && node.kind !== 'branch')) {
      return;
    }
    await this.bases.set(node.repo.commonDir, base);
    this.logger.info('comparison base set', { function: 'setBase', repo: node.repo.name, base });
    // Reload, not just redraw: the ahead/behind counts on every row are relative to the base.
    this.repositories.refreshRepo(node.repo);
  }

  /** Back to the repo's default branch. */
  async clearBase(node: RepoTreeNode): Promise<void> {
    if (node.kind === 'message') {
      return;
    }
    await this.bases.clear(node.repo.commonDir);
    this.logger.info('comparison base cleared', { function: 'clearBase', repo: node.repo.name });
    this.repositories.refreshRepo(node.repo);
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
    const entries = multiDiffEntries(nodes);
    const title = nodes.every((n) => n.result === first.result)
      ? `${first.result.baseLabel ?? 'base'} ↔ ${subjectTitle(first.result.subject)}`
      : 'All repos ↔ base';
    await vscode.commands.executeCommand('vscode.changes', title, entries);
  }

  /**
   * Commits group → one commit: open the files it changed (against its first parent) in one
   * multi-file diff. The comparison on display is left as it is.
   */
  async openCommit(node: ChangesNode): Promise<void> {
    if (node.kind !== 'commit') {
      return;
    }
    await openCommitChanges(await this.getGit(), node.result.repo, subjectCwd(node.result), node.commit, this.logger);
  }

  /**
   * Commit context menu: keep what is being reviewed, but compare it with this commit, i.e. show
   * only what came after it. In a multi-repo comparison this narrows to the commit's repo, since
   * a commit exists in one repo only.
   */
  async compareWithCommit(node: ChangesNode): Promise<void> {
    const state = this.changes.current();
    if (node.kind !== 'commit' || state === undefined) {
      return;
    }
    const requests = state.setup.requests.filter((r) => r.repo.commonDir === node.result.repo.commonDir && isSameSubject(r.subject, node.result.subject));
    await this.run({ ...state.setup, requests, base: { kind: 'ref', ref: node.commit.sha, refKind: 'commit', label: commitTitle(node.commit) } });
  }

  /** Title bar "Swap Sides": review the base against what was being reviewed. */
  async swapSides(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    const outcome = swapSides(state.setup, state.results);
    if ('reason' in outcome) {
      void vscode.window.showInformationMessage(outcome.reason);
      return;
    }
    this.logger.info('comparison sides swapped', { function: 'swapSides', before: state.setup.base, after: outcome.setup.base });
    await this.run(outcome.setup);
  }

  /**
   * Changed file → Open File (right: the file on disk, editable, or the subject revision) or
   * Open File at Base (left: the base revision, read-only). The menus hide the side that does
   * not exist; the empty check covers a stale menu.
   */
  async openFileSide(node: ChangesNode, side: 'left' | 'right'): Promise<void> {
    if (node.kind !== 'file') {
      return;
    }
    const sides = diffSides(node.result, node.file);
    const source = side === 'left' ? sides.left : sides.right;
    if (source.kind === 'empty') {
      void vscode.window.showInformationMessage(`${node.file.path} does not exist on the ${side === 'left' ? 'base' : 'reviewed'} side.`);
      return;
    }
    await vscode.commands.executeCommand('vscode.open', sideToUri(source, side === 'left' ? node.file.oldPath : node.file.path));
  }

  /** Recompute the comparison on display (edits since, new commits, a fresh base snapshot). */
  async rerun(): Promise<void> {
    const state = this.changes.current();
    if (state !== undefined) {
      await this.run(state.setup);
    }
  }

  /**
   * Automatic rerun (file watchers / git events). Unlike `rerun` it does not focus the view, and it
   * only redraws when the results differ. It is also discarded if the user started a different
   * comparison while it ran, so a background run never overwrites a newer choice.
   */
  async rerunQuietly(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    const results = await this.compute(state.setup);
    if (this.changes.current() !== state) {
      return;
    }
    const baseFetch = await this.baseFetchInfo(results);
    if (stableSignature({ results, baseFetch }) === stableSignature({ results: state.results, baseFetch: state.baseFetch })) {
      return;
    }
    this.logger.debug('comparison auto-refreshed', { function: 'rerunQuietly', fileCount: results.reduce((n, r) => n + r.files.length, 0) });
    this.changes.show({ ...state, results, baseFetch });
  }

  /**
   * Minute timer: re-evaluate the fetch age shown on the base row (e.g. crossing the stale
   * threshold) from cached fetch times. Runs no git commands.
   */
  async refreshAges(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    const baseFetch = await this.baseFetchInfo(state.results);
    if (this.changes.current() === state && stableSignature(baseFetch) !== stableSignature(state.baseFetch)) {
      this.changes.show({ ...state, baseFetch });
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

  /** Header row "Against: …": pick a different base for the comparison on display. */
  async changeBase(): Promise<void> {
    const state = this.changes.current();
    if (state === undefined) {
      return;
    }
    const only = state.setup.requests.length === 1 ? state.setup.requests[0] : undefined;
    const base =
      only !== undefined ? await this.pickAgainst(only.repo, only.subject, `Review ${only.subject.label} against…`) : await this.pickBaseAcrossRepos(state.setup.requests);
    if (base !== undefined) {
      await this.run({ ...state.setup, base });
    }
  }

  /** Header row "Reviewing: …": include / exclude the subject worktree's uncommitted edits. */
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

  /** Show a comparison in Changes (from other views: History's Review This Commit, …). */
  async review(setup: ComparisonSetup): Promise<void> {
    this.logger.info('comparison requested', { function: 'review', requests: setup.requests.map((r) => ({ repo: r.repo.name, subject: r.subject })), base: setup.base });
    await this.run(setup);
  }

  private async run(setup: ComparisonSetup): Promise<void> {
    const results = await this.compute(setup);
    this.changes.show({ setup, results, baseFetch: await this.baseFetchInfo(results) });
    await vscode.commands.executeCommand('branchCompare.changes.focus');
  }

  private async compute(setup: ComparisonSetup): Promise<ComparisonResult[]> {
    const git = await this.getGit();
    const { includeUntracked } = settings();
    return vscode.window.withProgress({ location: { viewId: 'branchCompare.changes' }, title: 'Comparing…' }, () =>
      runComparisons(git, setup.requests, setup.base, setup.mode, { includeUntracked, logger: this.logger }),
    );
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

  /**
   * "Compare it with…" for one repo: the grouped choices of sideChoices.ts (Suggested, This
   * window, Worktrees, Branches, Remote branches, Tags, Commits), minus what is being reviewed.
   * @param reviewing - the Reviewing side, left out of the choices; undefined when choosing the
   *   repo's default Against.
   * @returns the Against side, or undefined if the picker was dismissed.
   */
  async pickAgainst(repo: RepoInfo, reviewing: Subject | undefined, title: string): Promise<BaseSpec | undefined> {
    const value = await this.pickSideValue(repo, 'against', reviewing, title);
    switch (value?.kind) {
      case undefined:
      case 'searchCommits':
        return undefined;
      case 'default':
        return { kind: 'default' };
      case 'stored':
        return value.base;
      case 'worktree':
        return this.worktreeBase(value.worktree);
      case 'ref':
        return { kind: 'ref', ref: value.ref, label: value.label, refKind: value.refKind };
    }
  }

  /** "What do you want to review?" for one repo. */
  private async pickReviewing(repo: RepoInfo, title: string): Promise<Subject | undefined> {
    const value = await this.pickSideValue(repo, 'review', undefined, title);
    switch (value?.kind) {
      case 'worktree':
        return { kind: 'worktree', root: value.worktree.path, label: worktreeLabel(value.worktree), includeUncommitted: settings().includeUncommitted };
      case 'ref':
        return { kind: 'ref', ref: value.ref, label: value.label, refKind: value.refKind };
      default:
        // default / stored are Against-only choices; undefined = dismissed.
        return undefined;
    }
  }

  private async pickSideValue(repo: RepoInfo, role: SideRole, reviewing: Subject | undefined, title: string): Promise<SideValue | undefined> {
    const git = await this.getGit();
    const [defaultBranch, refs, worktrees, tags] = await Promise.all([
      git.defaultBranch(repo.root),
      this.repositories.getRefs(repo),
      this.repositories.getWorktrees(repo),
      git.tags(repo.root),
    ]);
    const choices = sideChoices({
      role,
      repoRoot: repo.root,
      worktrees,
      refs,
      tags,
      windowFolders: windowFolders(),
      defaultBranch,
      storedBase: role === 'against' ? this.bases.get(repo.commonDir) : undefined,
      reviewing,
      nowMs: Date.now(),
    });
    return pickSide(choices, role, title, () => git.recentCommits(repo.root, RECENT_COMMITS_LIMIT));
  }

  /** Base picker for a multi-repo comparison: default branches, or a branch name shared across repos. */
  private async pickBaseAcrossRepos(requests: readonly ComparisonRequest[]): Promise<BaseSpec | undefined> {
    const refLists = await Promise.all(requests.map((r) => this.repositories.getRefs(r.repo)));
    const candidates = rankBranchCandidates(
      refLists.map((refs) => refs.map((r) => ({ type: r.kind === 'local' ? RefType.Head : RefType.RemoteHead, name: r.name }))),
    );
    const items: BasePickItem[] = [
      { label: "$(star-full) Each repo's default branch", description: 'resolved per repo', base: { kind: 'default' } },
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

/**
 * Which repo to compare in: skipped when there is only one. Offers "All repositories" first,
 * which compares every repo's main worktree against its own default branch.
 * @returns a repo, 'all', or undefined when dismissed or there are no repos.
 */
async function pickRepository(repos: readonly RepoInfo[], offerAll = true): Promise<RepoInfo | 'all' | undefined> {
  if (repos.length === 0) {
    void vscode.window.showInformationMessage('No git repositories in this window.');
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const items: (vscode.QuickPickItem & { readonly repo: RepoInfo | 'all' })[] = [
    ...(offerAll ? [{ label: '$(repo) All repositories', description: 'each main worktree against its own default branch', repo: 'all' as const }] : []),
    ...repos.map((repo) => ({ label: `$(repo) ${repo.name}`, description: repo.root, repo })),
  ];
  return (await vscode.window.showQuickPick(items, { title: offerAll ? 'Compare: in which repository?' : 'In which repository?' }))?.repo;
}

/**
 * Any commit row → the commit it shows, for the shared commit actions: a commit in the Changes
 * view's Commits group, a History entry, or a Commits view row.
 */
async function resolveCommitTarget(node: unknown, repoFor: (root: string) => Promise<RepoInfo | undefined>): Promise<CommitTarget | undefined> {
  if (isChangesCommit(node)) {
    return { repo: node.result.repo, root: subjectCwd(node.result), commit: node.commit };
  }
  if (isCommitsCommit(node)) {
    return node.target;
  }
  if (isHistoryEntry(node)) {
    const repo = await repoFor(node.root);
    return repo === undefined ? undefined : { repo, root: node.root, commit: node.entry.commit };
  }
  return undefined;
}

// Command arguments arrive untyped from menus; these guards check which view's row it is.
function isChangesCommit(node: unknown): node is Extract<ChangesNode, { kind: 'commit' }> {
  return typeof node === 'object' && node !== null && 'kind' in node && node.kind === 'commit' && 'result' in node && 'commit' in node;
}

function isCommitsCommit(node: unknown): node is Extract<CommitsNode, { kind: 'commit' }> {
  return typeof node === 'object' && node !== null && 'kind' in node && node.kind === 'commit' && 'target' in node;
}

function isHistoryEntry(node: unknown): node is Extract<HistoryNode, { kind: 'entry' }> {
  return typeof node === 'object' && node !== null && 'kind' in node && node.kind === 'entry' && 'root' in node && 'entry' in node;
}

/** Folders open in this window; "this window" in the views and pickers means one of these. */
function windowFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
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

/** Same worktree (by path) or same ref (by name). */
function isSameSubject(a: Subject, b: Subject): boolean {
  return a.kind === 'worktree' ? b.kind === 'worktree' && a.root === b.root : b.kind === 'ref' && a.ref === b.ref;
}

/** True when the base IS the subject (comparing something with itself). */
function isSameSide(subject: Subject, base: BaseSpec): boolean {
  return subject.kind === 'worktree' ? baseMatches(base, { worktreeRoot: subject.root }) : baseMatches(base, { ref: subject.ref });
}

/** Subject name for diff titles; "committed" makes a HEAD-only worktree comparison explicit. */
function subjectTitle(subject: Subject): string {
  return subject.kind === 'worktree' && !subject.includeUncommitted ? `${subject.label}, committed` : subject.label;
}
