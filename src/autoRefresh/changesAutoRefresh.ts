/**
 * changesAutoRefresh — re-runs the comparison in the Changes view when its inputs change.
 *
 * Triggers (both debounced through one CoalescingRunner, so a burst becomes one rerun and reruns
 * never overlap):
 *   1. File events in the compared worktree folders (subject worktrees, and the base when it is a
 *      worktree). Needed because linked worktrees are usually not open in the window, so Cursor's
 *      git extension never reports their edits. Dependency/build/.git paths are ignored (watchPaths.ts).
 *   2. Git change events for any repo in the comparison (gitEvents.ts): commits, branch moves,
 *      fetches, and edits in repos that ARE open in the window.
 *
 * The rerun itself (CompareCommands.rerunQuietly) redraws only when results differ, which also
 * ends the one feedback path that exists: a base snapshot writes git objects, which can make the
 * git extension run `git status` and report a change; the follow-up rerun finds identical results
 * and stops there.
 *
 * Controlled by `branchCompare.autoRefresh` (default on). Watchers are rebuilt only when the set of
 * watched folders changes, not on every refresh.
 */
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import type { ChangesProvider, ChangesState } from '../views/changesView';
import { CoalescingRunner } from './scheduling';
import { involvedCommonDirs, isIgnoredChange, watchedRoots } from './watchPaths';

// Quiet period before rerunning: long enough to cover "save all" and formatter-on-save bursts.
const RERUN_DEBOUNCE_MS = 1_500;

/** Keeps the Changes view current while a comparison is displayed. */
export class ChangesAutoRefresh implements vscode.Disposable {
  private readonly runner: CoalescingRunner;
  private watchers: vscode.Disposable[] = [];
  // Sorted, joined watched roots; rebuild watchers only when this changes.
  private watchedKey = '';
  private involved = new Set<string>();
  private readonly stateSubscription: vscode.Disposable;

  /**
   * @param rerun - recompute and redraw-if-changed (CompareCommands.rerunQuietly).
   * @param isEnabled - reads the `branchCompare.autoRefresh` setting.
   */
  constructor(
    private readonly changes: ChangesProvider,
    rerun: () => Promise<void>,
    private readonly isEnabled: () => boolean,
    private readonly logger: Logger,
  ) {
    this.runner = new CoalescingRunner(RERUN_DEBOUNCE_MS, rerun, (error) =>
      // Background work: never a toast. The next trigger (or a manual Refresh) retries.
      this.logger.warn('automatic comparison refresh failed', {
        function: 'ChangesAutoRefresh.run',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    this.stateSubscription = changes.onDidChangeState((state) => this.follow(state));
  }

  /** A repo changed (git events); rerun if it is part of the comparison on display. */
  repoChanged(commonDir: string): void {
    if (this.isEnabled() && this.involved.has(commonDir)) {
      this.runner.schedule();
    }
  }

  /** The setting changed: start or stop watching. */
  settingChanged(): void {
    this.watchedKey = '';
    this.follow(this.changes.current());
  }

  dispose(): void {
    this.stateSubscription.dispose();
    this.runner.dispose();
    this.disposeWatchers();
  }

  private follow(state: ChangesState | undefined): void {
    if (state === undefined || !this.isEnabled()) {
      this.involved = new Set();
      this.watchedKey = '';
      this.disposeWatchers();
      return;
    }
    this.involved = involvedCommonDirs(state.setup);
    const roots = watchedRoots(state.setup);
    const key = roots.join('\n');
    if (key === this.watchedKey) {
      return;
    }
    this.disposeWatchers();
    this.watchedKey = key;
    this.watchers = roots.map((root) => this.watchFolder(root));
    this.logger.debug('watching compared folders', { function: 'ChangesAutoRefresh.follow', roots });
  }

  private watchFolder(root: string): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'));
    const onEvent = (uri: vscode.Uri): void => {
      if (!isIgnoredChange(root, uri.fsPath)) {
        this.runner.schedule();
      }
    };
    return vscode.Disposable.from(watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent), watcher.onDidDelete(onEvent));
  }

  private disposeWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }
}
