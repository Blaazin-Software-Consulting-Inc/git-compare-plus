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
 * Feedback guard: if reruns keep being triggered while they run and keep finding nothing new, the
 * runner stops following those triggers (CoalescingRunner, scheduling.ts) and logs one WARN. Each
 * trigger is logged at DEBUG with its source (file path or repo) so such a loop can be traced.
 *
 * Controlled by `gitComparePlus.autoRefresh` (default on). Watchers are rebuilt only when the set of
 * watched folders changes, not on every refresh.
 *
 * Failures: an automatic rerun never shows an error popup per failure. While reruns fail, the
 * view's message bar says the list is from earlier (failureTracker.ts); if the failure persists
 * (3 in a row or 1 minute), `onPersistentFailure` is called once for that episode. Any successful
 * comparison, automatic or manual, ends the episode and clears the message.
 */
import * as vscode from 'vscode';
import type { Logger } from '../logger';
import type { ChangesProvider, ChangesState } from '../views/changesView';
import { FailureTracker, staleMessage } from './failureTracker';
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
  // One key: the comparison on display.
  private readonly failures = new FailureTracker<'changes'>();

  /**
   * @param rerun - recompute and redraw-if-changed (CompareCommands.rerunQuietly); resolves whether
   *   the results changed; rejects on failure.
   * @param isEnabled - reads the `gitComparePlus.autoRefresh` setting.
   * @param onPersistentFailure - called once per failure episode that persists.
   */
  constructor(
    private readonly changes: ChangesProvider,
    rerun: () => Promise<boolean>,
    private readonly isEnabled: () => boolean,
    private readonly onPersistentFailure: (reason: string) => void,
    private readonly logger: Logger,
  ) {
    this.runner = new CoalescingRunner(
      RERUN_DEBOUNCE_MS,
      async () => {
        const changed = await rerun();
        this.recovered();
        return changed;
      },
      (error) => this.failed(error),
      {
        onFeedbackStopped: (echoes) =>
          this.logger.warn('automatic refresh loop stopped', {
            function: 'ChangesAutoRefresh.run',
            echoes,
            watchedRoots: this.watchedKey.split('\n'),
            hint: 'each rerun was triggered while the previous one ran and found nothing new; set the Git Compare+ log level to Debug to see the triggers',
          }),
      },
    );
    this.stateSubscription = changes.onDidChangeState((state) => {
      // Every shown comparison was computed successfully (manual or automatic): the list is
      // current again, so any failure episode is over.
      if (state !== undefined) {
        this.recovered();
      }
      this.follow(state);
    });
  }

  /** Minute timer: keep the "(2 min ago)" in the stale message current. */
  refreshMessage(): void {
    const episode = this.failures.get('changes');
    this.changes.setStaleMessage(episode === undefined ? undefined : staleMessage('the comparison', episode, Date.now()));
  }

  /** A repo changed (git events); rerun if it is part of the comparison on display. */
  repoChanged(commonDir: string): void {
    if (this.isEnabled() && this.involved.has(commonDir)) {
      this.logger.debug('automatic refresh triggered', { function: 'repoChanged', trigger: 'git', commonDir });
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
      // Nothing is auto-refreshing any more, so "couldn't refresh" no longer applies.
      this.failures.forget('changes');
      this.changes.setStaleMessage(undefined);
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
        this.logger.debug('automatic refresh triggered', { function: 'watchFolder', trigger: 'file', path: uri.fsPath });
        this.runner.schedule();
      }
    };
    return vscode.Disposable.from(watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent), watcher.onDidDelete(onEvent));
  }

  private recovered(): void {
    if (this.failures.recordSuccess('changes')) {
      this.refreshMessage();
    }
  }

  // Background failure: never a popup per failure; the message bar says the list is from earlier,
  // and a persistent episode escalates once. The next trigger (or a manual Refresh) retries.
  private failed(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const { notify, episode } = this.failures.recordFailure('changes', reason, Date.now());
    this.logger.warn('automatic comparison refresh failed', {
      function: 'ChangesAutoRefresh.run',
      reason,
      consecutiveFailures: episode.consecutive,
      failingSince: new Date(episode.since).toISOString(),
    });
    if (notify) {
      this.logger.error('automatic comparison refresh keeps failing', error, {
        function: 'ChangesAutoRefresh.run',
        consecutiveFailures: episode.consecutive,
        failingSince: new Date(episode.since).toISOString(),
      });
      this.onPersistentFailure(reason);
    }
    this.refreshMessage();
  }

  private disposeWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }
}
