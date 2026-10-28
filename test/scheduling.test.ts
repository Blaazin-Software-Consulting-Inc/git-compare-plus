import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoalescingRunner, KeyedDebouncer, stableSignature } from '../src/autoRefresh/scheduling';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('KeyedDebouncer', () => {
  it('fires once per key after the quiet period, keys independent', () => {
    const fired: string[] = [];
    const debouncer = new KeyedDebouncer<string>(1000, (k) => fired.push(k));

    debouncer.trigger('a');
    vi.advanceTimersByTime(600);
    debouncer.trigger('a'); // resets a's timer
    debouncer.trigger('b');
    vi.advanceTimersByTime(999);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired.sort()).toEqual(['a', 'b']);
  });

  it('dispose cancels pending actions', () => {
    const action = vi.fn();
    const debouncer = new KeyedDebouncer<string>(100, action);
    debouncer.trigger('a');
    debouncer.dispose();
    vi.advanceTimersByTime(1000);
    expect(action).not.toHaveBeenCalled();
  });
});

describe('CoalescingRunner', () => {
  it('debounces a burst of triggers into one run', async () => {
    const task = vi.fn(async () => {});
    const runner = new CoalescingRunner(500, task, vi.fn());
    for (let i = 0; i < 10; i++) {
      runner.schedule();
      vi.advanceTimersByTime(100);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('never overlaps: triggers during a run cause exactly one follow-up run', async () => {
    let release: () => void = () => {};
    let active = 0;
    let peak = 0;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          active++;
          peak = Math.max(peak, active);
          release = () => {
            active--;
            resolve();
          };
        }),
    );
    const runner = new CoalescingRunner(100, task, vi.fn());

    runner.schedule();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
    runner.schedule();
    runner.schedule();
    runner.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(1); // still running; nothing overlapped

    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(2); // one follow-up for all three triggers
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });

  it('reports task errors and keeps working', async () => {
    const onError = vi.fn();
    const task = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const runner = new CoalescingRunner(10, task, onError);
    runner.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    runner.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(task).toHaveBeenCalledTimes(2);
  });

  // A task that triggers itself while it runs, as a watcher reporting the run's own git commands
  // would; `changed` says what each run reports.
  function selfTriggering(changed: () => boolean, onFeedbackStopped = vi.fn()) {
    let runner: CoalescingRunner | undefined;
    const task = vi.fn(async () => {
      runner?.schedule();
      return changed();
    });
    runner = new CoalescingRunner(100, task, vi.fn(), { onFeedbackStopped });
    return { runner, task, onFeedbackStopped };
  }

  it('stops a feedback loop: runs that trigger themselves and find nothing new', async () => {
    const { runner, task, onFeedbackStopped } = selfTriggering(() => false);
    runner.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    // The first run plus three follow-ups, then the loop is cut and reported once.
    expect(task).toHaveBeenCalledTimes(4);
    expect(onFeedbackStopped).toHaveBeenCalledTimes(1);
  });

  it('still runs for a trigger that arrives while idle after a loop was stopped, without reporting again', async () => {
    const { runner, task, onFeedbackStopped } = selfTriggering(() => false);
    runner.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    runner.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(5);
    expect(onFeedbackStopped).toHaveBeenCalledTimes(1);
  });

  it('keeps following triggers during runs that find changes (real edits while it runs)', async () => {
    let runs = 0;
    const { runner, task, onFeedbackStopped } = selfTriggering(() => ++runs <= 8);
    runner.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    // 8 changed runs, then the guard needs 3 unchanged follow-ups before it cuts in.
    expect(task).toHaveBeenCalledTimes(12);
    expect(onFeedbackStopped).toHaveBeenCalledTimes(1);
  });

  it('treats a task that reports nothing as a change, so plain tasks are never cut off', async () => {
    let runner: CoalescingRunner | undefined;
    let runs = 0;
    const task = vi.fn(async () => {
      if (++runs < 10) {
        runner?.schedule();
      }
    });
    runner = new CoalescingRunner(100, task, vi.fn());
    runner.schedule();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(10);
  });

  it('dispose cancels a pending run and ignores later triggers', async () => {
    const task = vi.fn(async () => {});
    const runner = new CoalescingRunner(100, task, vi.fn());
    runner.schedule();
    runner.dispose();
    runner.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).not.toHaveBeenCalled();
  });
});

describe('stableSignature', () => {
  it('ignores Map insertion order and undefined fields', () => {
    expect(stableSignature({ m: new Map([['b', 2], ['a', 1]]), x: undefined })).toBe(stableSignature({ m: new Map([['a', 1], ['b', 2]]) }));
  });
  it('differs when content differs', () => {
    expect(stableSignature({ files: ['a'] })).not.toBe(stableSignature({ files: ['a', 'b'] }));
  });
});
