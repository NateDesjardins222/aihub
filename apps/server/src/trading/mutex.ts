/**
 * A per-key async mutex.
 *
 * Every mutation for an account is serialized through this. Without it, two
 * market events arriving microseconds apart can both read the same position,
 * both decide the stop should fill, and both write — leaving a doubled fill and
 * a position that never existed.
 *
 * Node being single-threaded does not help. Every `await` inside the critical
 * section is a yield point, and the engine awaits the database on every pass.
 */
export class KeyedMutex {
  /** Tail of the queue per key. Always a promise that cannot reject. */
  private readonly tails = new Map<string, Promise<unknown>>();
  /** How many tasks are queued or running per key, so keys can be released. */
  private readonly depth = new Map<string, number>();

  /**
   * Run `task` with exclusive access to `key`, queued behind anything pending.
   *
   * A task that throws still releases the lock, and still lets the next task
   * run: one rejected order must not wedge an account forever.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.depth.set(key, (this.depth.get(key) ?? 0) + 1);

    // `then(task, task)` runs the next task whether the previous one resolved
    // or rejected, so a failure does not stall the queue.
    const result = previous.then(task, task);

    // The stored tail must never reject, or the next `.then` would inherit an
    // unhandled rejection.
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );

    void result
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => this.release(key));

    return result;
  }

  private release(key: string): void {
    const remaining = (this.depth.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.depth.set(key, remaining);
      return;
    }
    this.depth.delete(key);
    this.tails.delete(key);
  }

  /** Keys with work queued or in flight. Diagnostics only. */
  get activeKeys(): number {
    return this.depth.size;
  }

  /** Queue depth for one key. Diagnostics only. */
  depthOf(key: string): number {
    return this.depth.get(key) ?? 0;
  }
}
