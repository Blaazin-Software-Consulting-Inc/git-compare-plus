/**
 * failureTracker — turns a stream of background-refresh outcomes into "failure episodes", so the
 * UI can (a) mark a view as showing stale data while an episode lasts and (b) notify the user at
 * most once per episode, and only when the failure persists.
 *
 * Episode lifecycle:
 *   no episode ──failure──▶ episode (consecutive = 1) ──failure──▶ … ──success──▶ no episode
 *   The episode is "persistent" once it reaches `minAttempts` consecutive failures OR has lasted
 *   `minDurationMs`; the first failure that makes it persistent returns `notify: true`. Later
 *   failures in the same episode never notify again; a success ends the episode, and the next
 *   failure starts a new one that may notify again.
 *
 * Why thresholds: most background failures are momentary (git's index.lock held during a commit
 * or rebase) and clear on the next trigger a second later. Only a failure that keeps happening
 * deserves to interrupt the user; a momentary one only shows in the view's message bar.
 *
 * Pure (time passed in); unit-tested in test/failureTracker.test.ts.
 */
import { formatAge } from '../operations';

/** A failure episode in progress. */
export interface FailureEpisode {
  /** When the first failure of the episode happened (ms since epoch). */
  readonly since: number;
  /** When the latest failure happened (ms since epoch). */
  readonly lastAt: number;
  readonly consecutive: number;
  /** Message of the latest failure, for display. */
  readonly reason: string;
  /** True once the user has been notified for this episode. */
  readonly notified: boolean;
}

/** When an episode counts as persistent. */
export interface PersistenceThresholds {
  readonly minAttempts: number;
  readonly minDurationMs: number;
}

/** 3 failures in a row, or failing for a minute. */
export const DEFAULT_THRESHOLDS: PersistenceThresholds = { minAttempts: 3, minDurationMs: 60_000 };

/** Tracks failure episodes per key (e.g. per repo; a single key for the Changes view). */
export class FailureTracker<K> {
  private readonly episodes = new Map<K, FailureEpisode>();

  constructor(private readonly thresholds: PersistenceThresholds = DEFAULT_THRESHOLDS) {}

  /**
   * Record a failure.
   * @returns `notify: true` exactly once per episode: when it first becomes persistent.
   */
  recordFailure(key: K, reason: string, now: number): { notify: boolean; episode: FailureEpisode } {
    const previous = this.episodes.get(key);
    const since = previous?.since ?? now;
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const persistent = consecutive >= this.thresholds.minAttempts || now - since >= this.thresholds.minDurationMs;
    const notify = persistent && previous?.notified !== true;
    const episode: FailureEpisode = { since, lastAt: now, consecutive, reason, notified: previous?.notified === true || notify };
    this.episodes.set(key, episode);
    return { notify, episode };
  }

  /** Record a success; returns true when this ended an episode (the view should clear its marker). */
  recordSuccess(key: K): boolean {
    return this.episodes.delete(key);
  }

  /** The episode in progress for a key, if any. */
  get(key: K): FailureEpisode | undefined {
    return this.episodes.get(key);
  }

  /** Every key currently failing, with its episode. */
  all(): [K, FailureEpisode][] {
    return [...this.episodes.entries()];
  }

  /** Forget a key entirely (e.g. the repo left the window). */
  forget(key: K): void {
    this.episodes.delete(key);
  }
}

/**
 * Message-bar text for views whose data may be stale: says what failed, how long ago, and that
 * the data shown is from before. `subjects` names the failing things ("club-service", "2 repos").
 */
export function staleMessage(subject: string, episode: FailureEpisode, now: number): string {
  return `⚠ Couldn't refresh ${subject} (${formatAge(episode.lastAt, now)}): ${episode.reason}. Showing earlier results; Refresh to retry.`;
}

/**
 * Message for the Repositories view from all failing repos: one repo is named; several are counted
 * and the most recent failure is quoted.
 */
export function repositoriesStaleMessage(failing: readonly { name: string; episode: FailureEpisode }[], now: number): string | undefined {
  if (failing.length === 0) {
    return undefined;
  }
  const latest = failing.reduce((a, b) => (b.episode.lastAt > a.episode.lastAt ? b : a));
  const subject = failing.length === 1 ? latest.name : `${failing.length} repos`;
  return staleMessage(subject, latest.episode, now);
}
