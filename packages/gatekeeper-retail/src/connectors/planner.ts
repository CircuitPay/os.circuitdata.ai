// A single-alarm work planner for one Durable Object, after gatekeeper-scheduler's driver
// (schedule-driver.ts `#runAlarm`/`#planAlarm`/`#cleanupRevokedAccount`, driver-state.ts
// `retryDelay`), which does not export it (research R15):
//
// - every alarm first re-arms a watchdog at now + 5 minutes, so a handler that dies mid-batch is
//   retried rather than silently dropped;
// - due work items run in a small batch, oldest due first;
// - a failed item backs off by min(60 s · 2^(n-1), 1 h), with jitter;
// - the next alarm is the earliest due item, or none;
// - teardown deletes storage in bounded batches, one alarm each.

/** The watchdog: how long an alarm handler may take before the alarm fires again. */
export const WATCHDOG_MS = 5 * 60_000;
/** Work items run per alarm. */
export const BATCH_SIZE = 4;
/** First retry delay, and the cap of the exponential backoff. */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 3_600_000;
/** Storage keys deleted per teardown alarm. */
export const TEARDOWN_BATCH_SIZE = 100;

const WORK_PREFIX = "work:";

/** One scheduled unit of work. `attempts` counts consecutive failures. */
export type WorkItem<T> = { key: string; dueAt: number; attempts: number; payload: T };

/**
 * The backoff after the `attempts`-th consecutive failure: min(60 s · 2^(n-1), 1 h), scaled by a
 * jitter factor in [0.5, 1] so a fleet of connections that failed together does not retry together.
 */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempts, 32) - 1);
  const capped = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
  return Math.round(capped * (0.5 + random() * 0.5));
}

/** The work queue and alarm of one Durable Object, over its synchronous KV storage. */
export class Planner<T> {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  /** Arms the watchdog. Call first in `alarm()`, before any work. */
  async armWatchdog(now = Date.now()): Promise<void> {
    await this.#storage.setAlarm(now + WATCHDOG_MS);
  }

  /** Adds or replaces an item, due at `dueAt`. Replacing resets its failure count. */
  schedule(key: string, payload: T, dueAt: number): void {
    this.#storage.kv.put<WorkItem<T>>(WORK_PREFIX + key, { key, dueAt, attempts: 0, payload });
  }

  /** Adds an item unless one with the key exists; an existing item keeps its due time. */
  scheduleIfAbsent(key: string, payload: T, dueAt: number): void {
    if (this.get(key) === undefined) this.schedule(key, payload, dueAt);
  }

  get(key: string): WorkItem<T> | undefined {
    return this.#storage.kv.get<WorkItem<T>>(WORK_PREFIX + key);
  }

  /** Replaces an item's payload and due time, keeping its failure count reset (progress). */
  update(item: WorkItem<T>, payload: T, dueAt: number): void {
    this.#storage.kv.put<WorkItem<T>>(WORK_PREFIX + item.key, { key: item.key, dueAt, attempts: 0, payload });
  }

  remove(key: string): void {
    this.#storage.kv.delete(WORK_PREFIX + key);
  }

  /** Every item, in key order. */
  list(): WorkItem<T>[] {
    return [...this.#storage.kv.list<WorkItem<T>>({ prefix: WORK_PREFIX })].map(([, item]) => item);
  }

  /** The items due at `now`, earliest first, at most `limit`. */
  due(now: number, limit = BATCH_SIZE): WorkItem<T>[] {
    return this.list()
      .filter(item => item.dueAt <= now)
      .toSorted((a, b) => a.dueAt - b.dueAt || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  /**
   * Records a failure: the item is retried after the backoff, or after `retryAfterMs` when the
   * provider said so and that is longer. Returns the delay.
   */
  fail(item: WorkItem<T>, now: number, retryAfterMs = 0): number {
    const attempts = item.attempts + 1;
    const delay = Math.max(backoffDelay(attempts), retryAfterMs);
    this.#storage.kv.put<WorkItem<T>>(WORK_PREFIX + item.key, { ...item, attempts, dueAt: now + delay });
    return delay;
  }

  /** Sets the alarm to the earliest due item, or deletes it when nothing is queued. */
  async plan(): Promise<void> {
    let target: number | undefined;
    for (const item of this.list()) {
      if (target === undefined || item.dueAt < target) target = item.dueAt;
    }
    if (target === undefined) await this.#storage.deleteAlarm();
    else await this.#storage.setAlarm(target);
  }

  /**
   * Deletes up to one batch of storage keys other than `keep`, then sets an immediate alarm while
   * anything else remains. Returns whether the storage is clean.
   */
  async teardownStep(keep: ReadonlySet<string>): Promise<boolean> {
    const kv = this.#storage.kv;
    const batch = [...kv.list({ limit: TEARDOWN_BATCH_SIZE + keep.size })]
      .map(([key]) => key)
      .filter(key => !keep.has(key))
      .slice(0, TEARDOWN_BATCH_SIZE);
    this.#storage.transactionSync(() => {
      for (const key of batch) kv.delete(key);
    });
    const remains = [...kv.list({ limit: keep.size + 1 })].some(([key]) => !keep.has(key));
    if (remains) await this.#storage.setAlarm(Date.now());
    else await this.#storage.deleteAlarm();
    return !remains;
  }
}
