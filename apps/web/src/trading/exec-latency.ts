/**
 * How long a trade takes, in segments.
 *
 * "Execution is fast" is not a measurement, and a single end-to-end number is
 * barely better: when it is slow, the one thing worth knowing is WHICH part is
 * slow. So each order is timed in the pieces a trader's click actually passes
 * through, and every piece is reported separately:
 *
 *   press      the event handler ran (pointer to JS)
 *   request    the request was on the wire
 *   ack        the server answered - accepted, or refused with a reason
 *   server     the server's own processing time, as it reports it
 *   state      authoritative state showing this order reached the store
 *   painted    the frame carrying that state was composited
 *   endToEnd   press to painted
 *
 * THE MARKET DATA PROVIDER'S DELAY IS NOT IN HERE. The feed is roughly ten
 * minutes behind and that is a property of the data, not of Atlas; folding it
 * into an execution number would hide both. `window.__atlasLatency()` measures
 * the feed. This measures the platform.
 *
 * Reading it: `window.__atlasExecLatency()` in the console, or the browser
 * harness in `tools/exec-latency.mjs`.
 */

export type ExecStage =
  | 'press'
  | 'request'
  | 'ack'
  | 'server'
  | 'state'
  | 'painted'
  | 'endToEnd';

const STAGES: readonly ExecStage[] = [
  'press',
  'request',
  'ack',
  'server',
  'state',
  'painted',
  'endToEnd',
];

/** Samples kept per stage. Hundreds of orders is a long session. */
const WINDOW = 1_000;

export interface ExecStageStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly worst: number;
}

export type ExecLatencyReport = Record<ExecStage, ExecStageStats> & {
  readonly orders: number;
  /** Orders that were answered but never seen in authoritative state. */
  readonly unreconciled: number;
  readonly rejected: number;
};

function stats(samples: readonly number[]): ExecStageStats {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, worst: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return {
    count: sorted.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    p99: Math.round(at(0.99)),
    min: Math.round(sorted[0]!),
    worst: Math.round(sorted[sorted.length - 1]!),
  };
}

interface Attempt {
  readonly pressedAt: number;
  requestedAt: number | null;
  ackedAt: number | null;
  reconciled: boolean;
}

class ExecLatency {
  private readonly samples = new Map<ExecStage, number[]>();
  private readonly attempts = new Map<string, Attempt>();
  private orders = 0;
  private rejected = 0;

  constructor() {
    for (const stage of STAGES) this.samples.set(stage, []);
  }

  /**
   * The trader's input reached our code.
   *
   * `at` is the event's own timestamp where one is available, so the gap
   * between the hardware event and the handler running is counted rather than
   * quietly excluded.
   */
  pressed(id: string, at?: number): void {
    const pressedAt = Date.now();
    this.attempts.set(id, { pressedAt, requestedAt: null, ackedAt: null, reconciled: false });
    if (at !== undefined && Number.isFinite(at)) {
      // `event.timeStamp` is on the performance clock, not the wall clock.
      const handlerDelay = performance.now() - at;
      this.add('press', handlerDelay);
    }
  }

  /** The request is going out now. */
  sent(id: string): void {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    attempt.requestedAt = Date.now();
    this.add('request', attempt.requestedAt - attempt.pressedAt);
  }

  /**
   * The server answered.
   *
   * `serverMs` is the server's own processing time when it reports one, which
   * separates "Atlas took a while to decide" from "the wire took a while".
   */
  acknowledged(id: string, serverMs?: number | null): void {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    attempt.ackedAt = Date.now();
    this.orders += 1;
    this.add('ack', attempt.ackedAt - (attempt.requestedAt ?? attempt.pressedAt));
    if (serverMs !== undefined && serverMs !== null) this.add('server', serverMs);
  }

  /** The server refused it. Measured the same way; it is still an answer. */
  refused(id: string, serverMs?: number | null): void {
    this.rejected += 1;
    this.acknowledged(id, serverMs);
    this.attempts.delete(id);
  }

  /**
   * Authoritative state carrying this order reached the store.
   *
   * Schedules the paint measurement in the next animation frame, which fires
   * once the browser has committed the frame that state produced - the first
   * instant the trader could have SEEN it.
   */
  reconciled(id: string): void {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.reconciled) return;
    attempt.reconciled = true;
    const stateAt = Date.now();
    this.add('state', stateAt - (attempt.ackedAt ?? attempt.pressedAt));
    requestAnimationFrame(() => {
      const paintedAt = Date.now();
      this.add('painted', paintedAt - stateAt);
      this.add('endToEnd', paintedAt - attempt.pressedAt);
      this.attempts.delete(id);
    });
  }

  private add(stage: ExecStage, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const list = this.samples.get(stage)!;
    list.push(value);
    if (list.length > WINDOW) list.splice(0, list.length - WINDOW);
  }

  report(): ExecLatencyReport {
    const out = {
      orders: this.orders,
      rejected: this.rejected,
      // Answered, but authoritative state never carried it: the number that
      // says the client and the server stopped agreeing.
      unreconciled: [...this.attempts.values()].filter((a) => a.ackedAt !== null && !a.reconciled)
        .length,
    } as Record<string, unknown>;
    for (const stage of STAGES) out[stage] = stats(this.samples.get(stage)!);
    return out as ExecLatencyReport;
  }

  reset(): void {
    for (const stage of STAGES) this.samples.set(stage, []);
    this.attempts.clear();
    this.orders = 0;
    this.rejected = 0;
  }
}

export const execLatency = new ExecLatency();

if (typeof window !== 'undefined') {
  (window as unknown as { __atlasExecLatency?: unknown }).__atlasExecLatency = () =>
    execLatency.report();
  (window as unknown as { __atlasExecLatencyReset?: unknown }).__atlasExecLatencyReset = () =>
    execLatency.reset();
}
