/**
 * gitEvents — follows Cursor's built-in git extension to learn when a repo changed.
 *
 * Signals used (git extension API v1, verified in Cursor 3.24 / VS Code 1.128):
 *   - `Repository.state.onDidChange` — fires after every `git status` the extension runs, i.e.
 *     after file saves, commits, checkouts, branch changes, fetches, and also on window focus.
 *     Frequent and noisy, so it is debounced per repo and consumers only redraw on real change.
 *   - `API.onDidOpenRepository` / `onDidCloseRepository` — the set of repos changed.
 *
 * A reported repo root may be a linked worktree the extension opened; it is mapped to its repo's
 * `.git` common dir (cached), which is how this extension identifies repos.
 *
 * See also: src/autoRefresh/scheduling.ts (debouncing), src/views/repositoriesView.ts
 * (refreshRepoIfChanged), src/autoRefresh/changesAutoRefresh.ts.
 */
import * as vscode from 'vscode';
import type { GitCli } from '../git/gitCli';
import type { Logger } from '../logger';
import { KeyedDebouncer } from './scheduling';

/** The git-extension members this module uses. */
export interface ObservableGitApi {
  readonly repositories: readonly ObservableRepository[];
  readonly onDidOpenRepository: vscode.Event<ObservableRepository>;
  readonly onDidCloseRepository: vscode.Event<ObservableRepository>;
}

/** A git-extension repository with its change event. */
export interface ObservableRepository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
}

/** What to do when something changed. */
export interface GitEventHandlers {
  /** A repo's HEAD, refs or working tree may have changed (debounced, per repo). */
  repoChanged(commonDir: string): void;
  /** Repos were opened or closed in the window (debounced). */
  reposChanged(): void;
}

// Quiet period before reacting. Long enough to absorb a checkout/rebase burst, short enough to
// feel immediate after a commit.
const REPO_DEBOUNCE_MS = 1_000;
const SET_DEBOUNCE_MS = 1_500;

/**
 * Subscribe to git-extension events for the window's lifetime.
 * @returns a Disposable that removes every subscription and pending timer.
 */
export function followGitChanges(api: ObservableGitApi, git: GitCli, handlers: GitEventHandlers, logger: Logger): vscode.Disposable {
  // Root path → common dir; a root's repo identity never changes, so cache forever.
  const commonDirByRoot = new Map<string, Promise<string | undefined>>();
  const resolveCommonDir = (root: string): Promise<string | undefined> => {
    let pending = commonDirByRoot.get(root);
    if (pending === undefined) {
      pending = git.commonDir(root).catch((error: unknown) => {
        // A root that vanished (worktree removed) cannot be resolved; nothing to refresh for it.
        logger.debug('common dir unavailable for changed repo', {
          function: 'followGitChanges',
          root,
          reason: error instanceof Error ? error.message : String(error),
        });
        commonDirByRoot.delete(root);
        return undefined;
      });
      commonDirByRoot.set(root, pending);
    }
    return pending;
  };

  const perRepo = new KeyedDebouncer<string>(REPO_DEBOUNCE_MS, (root) => {
    void resolveCommonDir(root).then((commonDir) => {
      if (commonDir !== undefined) {
        handlers.repoChanged(commonDir);
      }
    });
  });
  const repoSet = new KeyedDebouncer<'set'>(SET_DEBOUNCE_MS, () => handlers.reposChanged());

  const subscriptions = new Map<string, vscode.Disposable>();
  const watch = (repo: ObservableRepository): void => {
    const root = repo.rootUri.fsPath;
    subscriptions.get(root)?.dispose();
    subscriptions.set(root, repo.state.onDidChange(() => perRepo.trigger(root)));
  };
  api.repositories.forEach(watch);

  const opened = api.onDidOpenRepository((repo) => {
    watch(repo);
    repoSet.trigger('set');
  });
  const closed = api.onDidCloseRepository((repo) => {
    const root = repo.rootUri.fsPath;
    subscriptions.get(root)?.dispose();
    subscriptions.delete(root);
    commonDirByRoot.delete(root);
    repoSet.trigger('set');
  });

  logger.debug('following git changes', { function: 'followGitChanges', repoCount: api.repositories.length });
  return new vscode.Disposable(() => {
    opened.dispose();
    closed.dispose();
    subscriptions.forEach((s) => s.dispose());
    subscriptions.clear();
    perRepo.dispose();
    repoSet.dispose();
  });
}
