/**
 * How long a market observation takes to reach a trader's eye.
 *
 * The brief asked for the complete path instrumented and reported at p50, p95
 * and p99, because "it feels slow" cannot be argued with or fixed. The path has
 * two halves and they are recorded separately on purpose:
 *
 *   VENDOR   exchange timestamp  ->  the poll response lands
 *   ATLAS    the response lands  ->  normalized  ->  published  ->  on the wire
 *
 * Only the second half is ours. Reporting one number for both would let a
 * 600-second vendor delay hide every millisecond we could actually save, and
 * would let us claim an improvement by changing the vendor's delay estimate.
 *
 * The client measures the rest - wire to paint - and reports it separately; see
 * `apps/web/src/market/latency.ts`.
 */

/** The stages an observation passes through inside the server. */
export type Stage =
  /** Exchange timestamp to the moment the HTTP response was parsed. */
  | 'vendor'
  /** Response parsed to normalization complete. */
  | 'normalize'
  /** Normalized to accepted by the bus. */
  | 'publish'
  /** Accepted by the bus to written to the socket. */
  | 'socket'
  /** Exchange timestamp to written to the socket. */
  | 'total'
  /** Response parsed to written to the socket: the part Atlas controls. */
  | 'atlas';

const STAGES: readonly Stage[] = ['vendor', 'normalize', 'publish', 'socket', 'total', 'atlas'];

/** How many samples to keep per stage. Two hours at one observation per 10s. */
const WINDOW = 720;

export interface StageStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export type LatencyReport = Record<Stage, StageStats> & {
  /** Distinct observations seen, and how many carried no timing. */
  readonly observations: number;
  readonly untimed: number;
};

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

function stats(samples: readonly number[]): StageStats {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    p99: Math.round(percentile(sorted, 0.99)),
    min: Math.round(sorted[0]!),
    max: Math.round(sorted[sorted.length - 1]!),
  };
}

/**
 * One observation's progress through the server.
 *
 * Created when a vendor response is parsed and carried on the event, so each
 * stage is measured against the same start rather than against a clock read at
 * an arbitrary later moment.
 */
export class Timing {
  readonly observedAt: number;
  readonly exchangeTs: number;
  normalizedAt: number | null = null;
  publishedAt: number | null = null;
  sentAt: number | null = null;

  constructor(exchangeTs: number, observedAt = Date.now()) {
    this.exchangeTs = exchangeTs;
    this.observedAt = observedAt;
  }
}

export class LatencyRecorder {
  private readonly samples = new Map<Stage, number[]>();
  private observations = 0;
  private untimed = 0;
  /**
   * The timing for each in-flight event, keyed by the event object itself.
   *
   * A WeakMap rather than a field on the domain type: a quote is a contract
   * shared with the browser and the database, and a transport measurement has
   * no business inside it. The entry disappears with the event.
   */
  private readonly inFlight = new WeakMap<object, Timing>();

  constructor() {
    for (const stage of STAGES) this.samples.set(stage, []);
  }

  /** Begin timing an observation, and attach it to the event it produced. */
  begin(event: object, exchangeTs: number, observedAt = Date.now()): Timing {
    const timing = new Timing(exchangeTs, observedAt);
    this.inFlight.set(event, timing);
    this.observations += 1;
    return timing;
  }

  /** Carry an existing timing onto a derived event, e.g. a bar from a quote. */
  inherit(from: object, to: object): void {
    const timing = this.inFlight.get(from);
    if (timing) this.inFlight.set(to, timing);
  }

  timingFor(event: object): Timing | null {
    return this.inFlight.get(event) ?? null;
  }

  markNormalized(event: object, at = Date.now()): void {
    const t = this.inFlight.get(event);
    if (!t) return;
    t.normalizedAt = at;
    this.add('normalize', at - t.observedAt);
  }

  markPublished(event: object, at = Date.now()): void {
    const t = this.inFlight.get(event);
    if (!t) return;
    t.publishedAt = at;
    this.add('publish', at - (t.normalizedAt ?? t.observedAt));
  }

  /**
   * The event has been written to every subscribed socket.
   *
   * This is the last moment the server can account for, so it is where the
   * vendor half and the Atlas half are both closed out.
   */
  markSent(event: object, at = Date.now()): void {
    const t = this.inFlight.get(event);
    if (!t) {
      this.untimed += 1;
      return;
    }
    t.sentAt = at;
    this.add('socket', at - (t.publishedAt ?? t.observedAt));
    this.add('atlas', at - t.observedAt);
    if (t.exchangeTs > 0) {
      this.add('vendor', t.observedAt - t.exchangeTs);
      this.add('total', at - t.exchangeTs);
    }
  }

  private add(stage: Stage, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const list = this.samples.get(stage)!;
    list.push(value);
    if (list.length > WINDOW) list.splice(0, list.length - WINDOW);
  }

  report(): LatencyReport {
    const out = { observations: this.observations, untimed: this.untimed } as Record<string, unknown>;
    for (const stage of STAGES) out[stage] = stats(this.samples.get(stage)!);
    return out as LatencyReport;
  }

  reset(): void {
    for (const stage of STAGES) this.samples.set(stage, []);
    this.observations = 0;
    this.untimed = 0;
  }
}
