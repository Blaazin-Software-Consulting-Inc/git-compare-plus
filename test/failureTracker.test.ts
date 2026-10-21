import { describe, expect, it } from 'vitest';
import { FailureTracker, repositoriesStaleMessage, staleMessage } from '../src/autoRefresh/failureTracker';

const T0 = Date.UTC(2026, 9, 21, 12);

describe('FailureTracker', () => {
  it('notifies exactly once, on the 3rd consecutive failure', () => {
    const tracker = new FailureTracker<string>();
    expect(tracker.recordFailure('r', 'lock', T0).notify).toBe(false);
    expect(tracker.recordFailure('r', 'lock', T0 + 1_000).notify).toBe(false);
    expect(tracker.recordFailure('r', 'lock', T0 + 2_000).notify).toBe(true);
    expect(tracker.recordFailure('r', 'lock', T0 + 3_000).notify).toBe(false);
    expect(tracker.get('r')).toMatchObject({ since: T0, lastAt: T0 + 3_000, consecutive: 4, notified: true });
  });

  it('notifies when an episode has lasted a minute, even with few attempts', () => {
    const tracker = new FailureTracker<string>();
    tracker.recordFailure('r', 'x', T0);
    expect(tracker.recordFailure('r', 'x', T0 + 60_000).notify).toBe(true);
  });

  it('a momentary failure followed by success never notifies', () => {
    const tracker = new FailureTracker<string>();
    tracker.recordFailure('r', 'lock', T0);
    expect(tracker.recordSuccess('r')).toBe(true);
    expect(tracker.get('r')).toBeUndefined();
    expect(tracker.recordSuccess('r')).toBe(false);
  });

  it('success ends the episode; a new episode can notify again', () => {
    const tracker = new FailureTracker<string>({ minAttempts: 2, minDurationMs: 1e9 });
    tracker.recordFailure('r', 'a', T0);
    expect(tracker.recordFailure('r', 'a', T0 + 1).notify).toBe(true);
    tracker.recordSuccess('r');
    tracker.recordFailure('r', 'b', T0 + 10);
    expect(tracker.recordFailure('r', 'b', T0 + 11).notify).toBe(true);
  });

  it('keys are independent; latest reason is kept; forget drops a key', () => {
    const tracker = new FailureTracker<string>();
    tracker.recordFailure('a', 'first', T0);
    tracker.recordFailure('a', 'second', T0 + 5);
    tracker.recordFailure('b', 'other', T0);
    expect(tracker.get('a')?.reason).toBe('second');
    expect(tracker.all().map(([k]) => k).sort()).toEqual(['a', 'b']);
    tracker.forget('a');
    expect(tracker.all().map(([k]) => k)).toEqual(['b']);
  });
});

describe('stale messages', () => {
  const episode = { since: T0, lastAt: T0, consecutive: 1, reason: 'index.lock exists', notified: false };

  it('says what failed, when, and that earlier results are shown', () => {
    expect(staleMessage('the comparison', episode, T0 + 2 * 60_000)).toBe(
      "⚠ Couldn't refresh the comparison (2 min ago): index.lock exists. Showing earlier results; Refresh to retry.",
    );
  });

  it('names a single repo, counts several, and quotes the most recent failure', () => {
    expect(repositoriesStaleMessage([], T0)).toBeUndefined();
    expect(repositoriesStaleMessage([{ name: 'club-service', episode }], T0)).toContain("Couldn't refresh club-service (just now)");
    const many = repositoriesStaleMessage(
      [
        { name: 'a', episode },
        { name: 'b', episode: { ...episode, lastAt: T0 + 1_000, reason: 'newer problem' } },
      ],
      T0 + 1_000,
    );
    expect(many).toContain("Couldn't refresh 2 repos");
    expect(many).toContain('newer problem');
  });
});
