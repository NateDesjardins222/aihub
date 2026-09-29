/**
 * Deterministic failure-injection framework (Engineering Resilience Phase 2, Part III).
 *
 * The Phase 1 attack harness forces concurrent *interleavings*. This forces
 * *crashes*: a synthetic error thrown at an exact point in a workflow so we can
 * prove the authoritative transaction either commits completely or rolls back
 * completely (never a partial write). It is TEST/DEV ONLY and touches no
 * production code — the injection is done entirely by wrapping the `db: Database`
 * handle that every domain function already takes as its first argument (the
 * clean dependency seam identified in the durability map). Production always runs
 * the real, unwrapped handle.
 *
 * How it works: a `FaultInjector` returns a `Proxy` over a drizzle `Database`.
 * It counts write operations (`insert`/`update`/`delete`/`execute`) — reads pass
 * through untouched — and, when the armed trip count is reached, throws a
 * `FailpointError` *instead of* issuing that write. Because the injection happens
 * inside the real `db.transaction(...)` callback, postgres-js issues a real
 * `ROLLBACK`, so the assertion "nothing partial survived" tests the genuine
 * database transaction boundary, not a mock.
 *
 * Typical use:
 *   const fx = new FaultInjector();
 *   fx.failOnWrite(2);                       // abort the 2nd write of the workflow
 *   await expect(provisionAccount(fx.wrap(db), input)).rejects.toThrow(FailpointError);
 *   // then assert the DB is exactly as if the call never happened.
 */
import type { Database } from '../../db/client.js';

/** The synthetic error an armed failpoint throws. Distinct so tests can match it. */
export class FailpointError extends Error {
  constructor(
    message: string,
    readonly opIndex: number,
    readonly method: string,
  ) {
    super(message);
    this.name = 'FailpointError';
  }
}

type WriteMethod = 'insert' | 'update' | 'delete' | 'execute';
const WRITE_METHODS: readonly WriteMethod[] = ['insert', 'update', 'delete', 'execute'];

/**
 * Counts and (optionally) fails write operations against a wrapped Database. The
 * same injector is shared across the top-level handle and any `tx` handed to a
 * `db.transaction` callback, so a trip count spans the whole workflow including
 * the writes inside its transaction.
 */
export class FaultInjector {
  private writeCount = 0;
  private tripAt: number | null = null;
  private mode: 'connection' | 'app' = 'app';
  /** Names of the writes seen, in order — useful for asserting the boundary shape. */
  readonly trace: string[] = [];

  /** Arm: throw on the Nth write operation (1-based) across the wrapped handle. */
  failOnWrite(n: number, mode: 'connection' | 'app' = 'app'): this {
    this.tripAt = n;
    this.mode = mode;
    return this;
  }

  /** How many write operations have been issued so far. */
  get writes(): number {
    return this.writeCount;
  }

  /** Disarm (subsequent writes pass through). */
  disarm(): this {
    this.tripAt = null;
    return this;
  }

  private onWrite(method: WriteMethod): void {
    this.writeCount += 1;
    this.trace.push(`${this.writeCount}:${method}`);
    if (this.tripAt !== null && this.writeCount === this.tripAt) {
      const label =
        this.mode === 'connection'
          ? `injected connection loss before write #${this.writeCount} (${method})`
          : `injected fault before write #${this.writeCount} (${method})`;
      throw new FailpointError(label, this.writeCount, method);
    }
  }

  /** Wrap a Database (or a transaction handle) so its writes are counted/failed. */
  wrap(db: Database): Database {
    const injector = this;
    return new Proxy(db, {
      get(target, prop, receiver) {
        // Fail-or-count the write builders.
        if (typeof prop === 'string' && (WRITE_METHODS as readonly string[]).includes(prop)) {
          return (...args: unknown[]) => {
            injector.onWrite(prop as WriteMethod); // throws here if this is the trip write
            const orig = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
            return orig.apply(target, args);
          };
        }
        // Re-enter the wrapper for the transaction's scoped handle so the trip
        // count spans writes inside the transaction too.
        if (prop === 'transaction') {
          const orig = Reflect.get(target, prop, receiver) as Database['transaction'];
          return (txFn: (tx: Database) => unknown, ...rest: unknown[]) =>
            (orig as unknown as (fn: (tx: unknown) => unknown, ...r: unknown[]) => unknown).call(
              target,
              (realTx: unknown) => txFn(injector.wrap(realTx as Database)),
              ...rest,
            );
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Database;
  }
}

/** Convenience: wrap `db` so the Nth write throws. */
export function failOnWrite(db: Database, n: number): { db: Database; injector: FaultInjector } {
  const injector = new FaultInjector().failOnWrite(n);
  return { db: injector.wrap(db), injector };
}
