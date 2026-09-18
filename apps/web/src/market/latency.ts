/**
 * The browser's half of the latency path.
 *
 * The server measures from the vendor's payload landing to the frame leaving
 * the socket. This measures what happens next - wire, store, render, paint -
 * against the SAME instant, which is why the server stamps `observedAt` on
 * every frame carrying a market observation.
 *
 * Three moments are recorded per observation:
 *
 *   received   the frame arrived and was parsed
 *   applied    the price reached the chart's series
 *   painted    the frame in which that happened was composited
 *
 * "Painted" is the number that matters, because it is the first instant a
 * trader could have seen the price. It is taken from a requestAnimationFrame
 * callback scheduled after the write, which fires once the browser has
 * committed the frame.
 *
 * Reading it: `window.__atlasLatency()` in the console, or the browser probe in
 * `tools/latency-probe.mjs`.
 */

export type ClientStage = 'wire' | 'apply' | 'paint' | 'endToEnd';

const STAGES: readonly ClientStage[] = ['wire', 'apply', 'paint', 'endToEnd'];
/** Samples kept per stage. */
const WINDOW = 600;

interface Pending {
  readonly observedAt: number;
  readonly receivedAt: number;
}

export interface ClientStageStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export type ClientLatencyReport = Record<ClientStage, ClientStageStats> & {
  readonly observations: number;
  /** Frames that arrived with no server stamp, so could not be measured. */
  readonly unstamped: number;
};

function stats(samples: readonly number[]): ClientStageStats {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return {
    count: sorted.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    p99: Math.round(at(0.99)),
    min: Math.round(sorted[0]!),
    max: Math.round(sorted[sorted.length - 1]!),
  };
}

class ClientLatency {
  private readonly samples = new Map<ClientStage, number[]>();
  /** The newest unconsumed observation per symbol. */
  private readonly pending = new Map<string, Pending>();
  private observations = 0;
  private unstamped = 0;

  constructor() {
    for (const stage of STAGES) this.samples.set(stage, []);
  }

  /** A frame carrying a market observation arrived. */
  received(symbol: string, observedAt: number | undefined): void {
    if (observedAt === undefined) {
      this.unstamped += 1;
      return;
    }
    const receivedAt = Date.now();
    this.observations += 1;
    this.add('wire', receivedAt - observedAt);
    this.pending.set(symbol, { observedAt, receivedAt });
  }

  /**
   * The price reached the chart. Schedules the paint measurement.
   *
   * Called from the animation frame that writes to the series, so the next
   * frame callback runs after the browser has committed this one.
   */
  applied(symbol: string): void {
    const p = this.pending.get(symbol);
    if (!p) return;
    this.pending.delete(symbol);
    const appliedAt = Date.now();
    this.add('apply', appliedAt - p.receivedAt);
    requestAnimationFrame(() => {
      const paintedAt = Date.now();
      this.add('paint', paintedAt - appliedAt);
      this.add('endToEnd', paintedAt - p.observedAt);
    });
  }

  private add(stage: ClientStage, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const list = this.samples.get(stage)!;
    list.push(value);
    if (list.length > WINDOW) list.splice(0, list.length - WINDOW);
  }

  report(): ClientLatencyReport {
    const out = { observations: this.observations, unstamped: this.unstamped } as Record<
      string,
      unknown
    >;
    for (const stage of STAGES) out[stage] = stats(this.samples.get(stage)!);
    return out as ClientLatencyReport;
  }

  reset(): void {
    for (const stage of STAGES) this.samples.set(stage, []);
    this.pending.clear();
    this.observations = 0;
    this.unstamped = 0;
  }
}

export const clientLatency = new ClientLatency();

if (typeof window !== 'undefined') {
  (window as unknown as { __atlasLatency?: unknown }).__atlasLatency = () => clientLatency.report();
  (window as unknown as { __atlasLatencyReset?: unknown }).__atlasLatencyReset = () =>
    clientLatency.reset();
}
