/**
 * Connection lifecycle framework (M4-D / M4-V).
 *
 * Provider-neutral machinery shared by professional adapters: a bounded
 * exponential-backoff reconnect policy and a heartbeat watchdog. Deterministic
 * and injectable-clock so it can be tested without real timers. It performs no
 * I/O itself — an adapter supplies the actual connect attempt and heartbeat
 * source. This exists so every provider reconnects the same, safe way (bounded,
 * never a storm), rather than each adapter inventing its own.
 */

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly factor: number;
  /** Give up after this many consecutive failures (0 = never give up). */
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  maxAttempts: 0,
};

/** The delay before attempt N (1-based), capped, deterministic (no jitter here). */
export function backoffDelayMs(policy: BackoffPolicy, attempt: number): number {
  if (attempt <= 0) return 0;
  const raw = policy.baseMs * policy.factor ** (attempt - 1);
  return Math.min(raw, policy.maxMs);
}

/** Whether another reconnect attempt is permitted under the policy. */
export function mayRetry(policy: BackoffPolicy, attemptsSoFar: number): boolean {
  return policy.maxAttempts === 0 || attemptsSoFar < policy.maxAttempts;
}

/**
 * A heartbeat watchdog. `feed()` records a heartbeat; `isStale(now)` reports
 * whether the last heartbeat is older than the timeout. Never fabricates a
 * heartbeat; a provider that goes silent goes stale.
 */
export class HeartbeatWatchdog {
  private lastBeatMs: number | null = null;
  constructor(private readonly timeoutMs: number) {}

  feed(atMs: number): void {
    this.lastBeatMs = atMs;
  }

  lastBeat(): number | null {
    return this.lastBeatMs;
  }

  isStale(nowMs: number): boolean {
    if (this.lastBeatMs === null) return true;
    return nowMs - this.lastBeatMs > this.timeoutMs;
  }

  reset(): void {
    this.lastBeatMs = null;
  }
}
