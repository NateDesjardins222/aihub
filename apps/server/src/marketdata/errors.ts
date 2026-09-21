/**
 * Market-data error classification and structured observability (Professional
 * Market Data V2, Phases 82-83).
 *
 * A market-data failure means different things operationally — a bad key, a
 * dropped socket, a provider outage, an unresolved contract, a stale feed, a
 * gap, malformed data — and they demand different responses. This module gives
 * them one vendor-neutral taxonomy so the adapter, the health endpoint and the
 * logs speak the same language, and a small structured logger that records
 * lifecycle events (connect, reconnect, subscription, gap, roll, staleness,
 * dropped events) WITHOUT logging every tick and WITHOUT ever carrying a
 * credential.
 */

export type MarketDataErrorKind =
  | 'AUTH'
  | 'NETWORK'
  | 'PROVIDER'
  | 'MAPPING'
  | 'CONTRACT'
  | 'STALE'
  | 'GAP'
  | 'INVALID_DATA'
  | 'INTERNAL';

export interface ClassifiedError {
  readonly kind: MarketDataErrorKind;
  /** A safe, credential-free description. */
  readonly message: string;
  /** True when retrying could succeed (network/provider), false for auth/mapping. */
  readonly retryable: boolean;
}

/**
 * Classify an error from a provider operation into the operational taxonomy.
 *
 * Never includes a credential: it reads only an error's name, an HTTP status,
 * and a short message that callers are required to keep credential-free.
 */
export function classifyMarketDataError(err: unknown): ClassifiedError {
  // A DatabentoHttpError (duck-typed to avoid importing the adapter here) carries
  // an HTTP status and an already-sanitized message.
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    const status = (err as { status: number }).status;
    const message = safeMessage(err);
    if (status === 401 || status === 403) return { kind: 'AUTH', message, retryable: false };
    if (status === 404) return { kind: 'MAPPING', message, retryable: false };
    if (status === 429) return { kind: 'PROVIDER', message, retryable: true };
    if (status >= 500) return { kind: 'PROVIDER', message, retryable: true };
    if (status >= 400) return { kind: 'INVALID_DATA', message, retryable: false };
  }
  if (err instanceof Error) {
    const name = err.name;
    if (name === 'SyntaxError' || name === 'TypeError') return { kind: 'INVALID_DATA', message: name, retryable: false };
    // fetch/socket failures surface as generic errors with connection-ish names.
    if (/network|fetch|socket|econn|timeout|abort/i.test(err.message) || name === 'FetchError') {
      return { kind: 'NETWORK', message: name, retryable: true };
    }
    return { kind: 'INTERNAL', message: name, retryable: false };
  }
  return { kind: 'INTERNAL', message: 'unknown', retryable: false };
}

function safeMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // Bound it: an error body must never become a place a secret echoes at length.
  return m.slice(0, 200);
}

/** A structured market-data lifecycle event — never a per-tick log. */
export interface MarketDataLogEvent {
  readonly at: number;
  readonly provider: string;
  readonly event:
    | 'connect'
    | 'connected'
    | 'disconnect'
    | 'reconnect'
    | 'degraded'
    | 'subscribe'
    | 'unsubscribe'
    | 'gap'
    | 'gap_recovered'
    | 'contract_roll'
    | 'mapping_change'
    | 'staleness'
    | 'dropped'
    | 'error';
  readonly symbol?: string;
  readonly detail?: Record<string, string | number | boolean | null>;
  readonly errorKind?: MarketDataErrorKind;
}

export type MarketDataLogSink = (event: MarketDataLogEvent) => void;

/**
 * A tiny structured logger for market-data lifecycle events. Default sink writes
 * one JSON line to stdout — coarse events only, never a tick. A test or a metrics
 * pipeline can substitute its own sink. Credentials are never passed in; the
 * classifier upstream guarantees messages are safe.
 */
export class MarketDataObserver {
  private readonly sink: MarketDataLogSink;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly provider: string,
    sink?: MarketDataLogSink,
  ) {
    this.sink = sink ?? ((e) => console.log(JSON.stringify({ md: e })));
  }

  emit(event: MarketDataLogEvent['event'], opts: Omit<MarketDataLogEvent, 'at' | 'provider' | 'event'> = {}): void {
    this.counts.set(event, (this.counts.get(event) ?? 0) + 1);
    this.sink({ at: Date.now(), provider: this.provider, event, ...opts });
  }

  error(err: unknown, opts: { symbol?: string } = {}): ClassifiedError {
    const classified = classifyMarketDataError(err);
    this.emit('error', { symbol: opts.symbol, errorKind: classified.kind, detail: { message: classified.message, retryable: classified.retryable } });
    return classified;
  }

  /** Event counts by type, for a health snapshot. Never per-symbol tick counts. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}
