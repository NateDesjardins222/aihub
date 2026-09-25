/**
 * A tiny injectable clock so payout-operations timing (the five-minute SLA) can be
 * tested deterministically without sleeping real seconds. Production passes the
 * system clock; tests pass a FakeClock they advance by hand.
 */
export interface Clock {
  now(): number;
  date(): Date;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  date: () => new Date(),
};

/** A hand-advanced clock for deterministic SLA / timing tests. */
export class FakeClock implements Clock {
  private t: number;
  constructor(startMs = 0) {
    this.t = startMs;
  }
  now(): number {
    return this.t;
  }
  date(): Date {
    return new Date(this.t);
  }
  set(ms: number): void {
    this.t = ms;
  }
  /** Advance by `ms` and return the new time. */
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}
