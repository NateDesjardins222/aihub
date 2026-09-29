/**
 * Deterministic concurrency attack harness (Engineering Resilience Phase 1, Part III).
 *
 * Reusable primitives for forcing exact interleavings and classifying the outcome
 * of many competing operations — WITHOUT scattering arbitrary sleeps. Tests use
 * these to attack invariants (account cap, reset, funded transition, payout
 * capacity, order idempotency) by launching N contenders that rendezvous at a
 * barrier so they hit the authoritative critical section as simultaneously as the
 * event loop allows, then asserting exactly how many succeeded.
 *
 * This is test/dev infrastructure. It contains no business logic and never runs in
 * production paths.
 */

/**
 * An N-party rendezvous. Every party calls `arrive()`; none proceeds until all N
 * have arrived, so the contenders leave the gate together. Deterministic: the
 * promise resolves for everyone in the same microtask turn once the last arrives.
 */
export class Barrier {
  private count = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly parties: number) {}
  arrive(): Promise<void> {
    this.count += 1;
    if (this.count >= this.parties) {
      for (const w of this.waiters) w();
      this.waiters.length = 0;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

export interface Settled<T> {
  fulfilled: T[];
  rejected: unknown[];
}

/**
 * Run every task concurrently and split the results into fulfilled/rejected — the
 * standard shape for "exactly K succeeded, the rest failed deterministically".
 */
export async function settleAll<T>(tasks: Array<() => Promise<T>>): Promise<Settled<T>> {
  const outcomes = await Promise.allSettled(tasks.map((t) => t()));
  const fulfilled: T[] = [];
  const rejected: unknown[] = [];
  for (const o of outcomes) {
    if (o.status === 'fulfilled') fulfilled.push(o.value);
    else rejected.push(o.reason);
  }
  return { fulfilled, rejected };
}

/**
 * Launch `n` contenders that each rendezvous at a shared barrier and then run
 * `attempt(i)`. Returns the fulfilled/rejected split. The barrier makes all `n`
 * enter the authoritative critical section together, maximising real contention on
 * the DB lock / unique index / version guard under test.
 */
export async function race<T>(n: number, attempt: (i: number) => Promise<T>): Promise<Settled<T>> {
  const barrier = new Barrier(n);
  return settleAll(
    Array.from({ length: n }, (_unused, i) => async () => {
      await barrier.arrive();
      return attempt(i);
    }),
  );
}
