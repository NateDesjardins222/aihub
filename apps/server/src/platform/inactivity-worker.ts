/**
 * The durable funded-account inactivity worker (Phase 12.5, HTF-18).
 *
 * `runInactivitySweep` was implemented and tested in an earlier milestone but was
 * never bound to anything, so the disclosed monthly-inactivity policy would never
 * actually fire. This is the binding: a small polling worker on the running server
 * that runs the sweep on a slow cadence.
 *
 * The sweep is idempotent and server-time authoritative — it reconstructs
 * everything from the database each run, checks the PREVIOUS completed calendar
 * month, and skips accounts already closed. So the exact tick timing does not
 * matter and a missed run (server down over a month boundary) simply catches up on
 * the next tick. There is no per-tick state to lose, which is what makes an
 * interval worker a durable job here. Tests call `tick()` directly.
 */
import type { Database } from '../db/client.js';
import { runInactivitySweep, type InactivitySweepResult } from './account-inactivity.js';

/** Default cadence: hourly. The sweep is cheap and idempotent; it need not be frequent. */
const DEFAULT_POLL_MS = 60 * 60 * 1000;

export class InactivityWorker {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly db: Database,
    private readonly opts: { pollMs?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.opts.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one sweep. Returns what it did, for logs and the on-demand route. */
  async tick(): Promise<InactivitySweepResult> {
    return runInactivitySweep(this.db);
  }
}
