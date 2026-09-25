/**
 * Rithmic provider metrics (Milestone 9).
 *
 * Bounded-cardinality counters + gauges for observability. Labels are the plant
 * kind or a small fixed set only — never an order id, account id or symbol (which
 * would make cardinality unbounded). Everything here is a number; no secret, no
 * PII, no free-form provider text.
 */
export type RithmicCounter =
  | 'connection_attempts'
  | 'auth_success'
  | 'auth_failure'
  | 'reconnects'
  | 'market_messages'
  | 'decode_failures'
  | 'stale_events'
  | 'historical_requests'
  | 'historical_failures'
  | 'orders_submitted'
  | 'order_acks'
  | 'order_rejects'
  | 'order_cancels'
  | 'order_modifies'
  | 'fills'
  | 'duplicate_executions_ignored'
  | 'reconciliation_mismatches'
  | 'unknown_submissions';

const COUNTER_NAMES: RithmicCounter[] = [
  'connection_attempts', 'auth_success', 'auth_failure', 'reconnects', 'market_messages',
  'decode_failures', 'stale_events', 'historical_requests', 'historical_failures',
  'orders_submitted', 'order_acks', 'order_rejects', 'order_cancels', 'order_modifies',
  'fills', 'duplicate_executions_ignored', 'reconciliation_mismatches', 'unknown_submissions',
];

export class RithmicMetrics {
  private readonly counters = new Map<RithmicCounter, number>();
  private heartbeatLatencyMs: number | null = null;

  inc(counter: RithmicCounter, by = 1): void {
    this.counters.set(counter, (this.counters.get(counter) ?? 0) + by);
  }

  get(counter: RithmicCounter): number {
    return this.counters.get(counter) ?? 0;
  }

  observeHeartbeatLatency(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.heartbeatLatencyMs = ms;
  }

  snapshot(): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const name of COUNTER_NAMES) out[name] = this.counters.get(name) ?? 0;
    out['heartbeat_latency_ms'] = this.heartbeatLatencyMs;
    return out;
  }

  reset(): void {
    this.counters.clear();
    this.heartbeatLatencyMs = null;
  }
}

/** A process-wide metrics registry for the Rithmic provider. */
export const rithmicMetrics = new RithmicMetrics();
