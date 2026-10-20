/**
 * scheduling — debounce and coalescing primitives for automatic refresh.
 *
 * Why: Cursor's git extension reports a repo change after EVERY `git status` it runs (file saves,
 * window focus, its own polling), and file watchers fire once per file during a checkout or
 * `npm install`. Reacting to each would run hundreds of git commands; instead:
 *   - KeyedDebouncer: one action per key after `delayMs` of quiet (per repo).
 *   - CoalescingRunner: one async task after `delayMs` of quiet; triggers that arrive while the
 *     task runs are folded into exactly one follow-up run, so the result reflects the latest
 *     state without ever running two in parallel.
 *
 * Pure (timers injectable); unit-tested with fake timers in test/scheduling.test.ts.
 */

/** Timer functions; injectable for tests. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Runs `action(key)` once per key after `delayMs` without a new trigger for that key. */
export class KeyedDebouncer<K> {
  private readonly pending = new Map<K, unknown>();

  constructor(
    private readonly delayMs: number,
    private readonly action: (key: K) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  trigger(key: K): void {
    const existing = this.pending.get(key);
    if (existing !== undefined) {
      this.timers.clearTimeout(existing);
    }
    this.pending.set(
      key,
      this.timers.setTimeout(() => {
        this.pending.delete(key);
        this.action(key);
      }, this.delayMs),
    );
  }

  /** Cancel everything pending (extension deactivation). */
  dispose(): void {
    for (const handle of this.pending.values()) {
      this.timers.clearTimeout(handle);
    }
    this.pending.clear();
  }
}

/**
 * Debounced async task that never overlaps itself.
 * State: idle → (schedule) waiting → (delay elapses) running → idle, or → waiting again when a
 * trigger arrived during the run.
 */
export class CoalescingRunner {
  private timer: unknown;
  private running = false;
  private rerunRequested = false;
  private disposed = false;

  /**
   * @param onError - receives a task failure; the runner keeps working afterwards.
   */
  constructor(
    private readonly delayMs: number,
    private readonly task: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  /** Request a run after `delayMs` of quiet. */
  schedule(): void {
    if (this.disposed) {
      return;
    }
    // A run is in flight: remember to run once more when it finishes instead of overlapping.
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
    }
    this.timer = this.timers.setTimeout(() => void this.run(), this.delayMs);
  }

  /** Stop: cancels a pending run; an in-flight run finishes but is not followed by another. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
    }
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    this.running = true;
    try {
      await this.task();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.schedule();
      }
    }
  }
}

/**
 * Deterministic string for change detection ("did a reload actually change anything?").
 * Maps become sorted entry lists; `undefined` object fields are dropped, as JSON does.
 */
export function stableSignature(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Map ? [...v.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)) : v,
  );
}
