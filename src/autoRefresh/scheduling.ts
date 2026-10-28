/**
 * scheduling — debounce and coalescing primitives for automatic refresh.
 *
 * Why: Cursor's git extension reports a repo change after EVERY `git status` it runs (file saves,
 * window focus, its own polling), and file watchers fire once per file during a checkout or
 * `npm install`. Reacting to each would run hundreds of git commands; instead:
 *   - KeyedDebouncer: one action per key after `delayMs` of quiet (per repo).
 *   - CoalescingRunner: one async task after `delayMs` of quiet; triggers that arrive while the
 *     task runs are folded into exactly one follow-up run, so the result reflects the latest
 *     state without ever running two in parallel. It also stops a feedback loop: when the task
 *     itself causes a trigger (seen in Cursor: Changes re-ran every 1.6 s for hours, each run
 *     finding nothing new), the follow-ups are dropped after MAX_ECHOES (see `run`).
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

// Follow-up runs allowed in a row when each was triggered during a run that found nothing new.
// Three is past any real burst (a save, then a formatter's save) yet stops a loop within seconds.
const MAX_ECHOES = 3;

/** Optional CoalescingRunner settings. */
export interface CoalescingRunnerOptions {
  /** Injectable for tests. */
  readonly timers?: Timers;
  /** Called once each time a feedback loop is detected and its follow-ups start being dropped. */
  readonly onFeedbackStopped?: (echoes: number) => void;
}

/**
 * Debounced async task that never overlaps itself.
 * State: idle → (schedule) waiting → (delay elapses) running → idle, or → waiting again when a
 * trigger arrived during the run (unless that is a feedback loop: see `run`).
 */
export class CoalescingRunner {
  private timer: unknown;
  private running = false;
  private rerunRequested = false;
  private disposed = false;
  // Consecutive follow-ups that were triggered during a run which found nothing new.
  private echoes = 0;
  private readonly timers: Timers;

  /**
   * @param task - resolves `false` when it ran but found nothing new (used to detect a feedback
   *   loop); `true` or nothing otherwise.
   * @param onError - receives a task failure; the runner keeps working afterwards.
   */
  constructor(
    private readonly delayMs: number,
    private readonly task: () => Promise<boolean | void>,
    private readonly onError: (error: unknown) => void,
    private readonly options: CoalescingRunnerOptions = {},
  ) {
    this.timers = options.timers ?? realTimers;
  }

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

  /**
   * Runs the task, then the one follow-up if triggers arrived meanwhile. Feedback guard: a trigger
   * that arrives DURING a run which then finds nothing new may have been caused by the run itself
   * (its git commands touching files a watcher reports). After MAX_ECHOES such follow-ups in a row
   * they are dropped; triggers that arrive while idle still run, and any run that finds a change
   * ends the streak. Cost: a real edit that lands mid-run during a loop waits for the next trigger.
   */
  private async run(): Promise<void> {
    this.timer = undefined;
    this.running = true;
    let changed: boolean | void = undefined;
    try {
      changed = await this.task();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
      const requested = this.rerunRequested;
      this.rerunRequested = false;
      if (changed === true || !requested) {
        this.echoes = 0;
      } else if (changed === false) {
        this.echoes++;
      }
      // A failed run with a pending trigger leaves the streak as it was.
      if (requested && this.echoes > MAX_ECHOES) {
        // Report once per loop: the first dropped follow-up.
        if (this.echoes === MAX_ECHOES + 1) {
          this.options.onFeedbackStopped?.(this.echoes);
        }
      } else if (requested) {
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
