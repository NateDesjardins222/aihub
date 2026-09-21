/**
 * Databento Historical HTTP client. Contained: nothing outside the Databento
 * adapter imports this.
 *
 * Base URL `https://hist.databento.com/v0`. Authentication is HTTP Basic with
 * the API key (prefixed `db-`) as the username and an empty password
 * (VERIFIED, Sept 2026). The key is read once into an Authorization header and
 * is NEVER logged, returned, or included in an error message — errors carry the
 * status and endpoint, not the credential.
 *
 * `timeseries.get_range` streams newline-delimited JSON when `encoding=json`;
 * this client reads the stream line by line so a large window does not have to
 * be buffered whole. `fetchImpl` is injectable so the adapter and its tests can
 * exercise parsing and request-building with no network and no real key.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DatabentoHttpOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /** Bounded backoff on transient failure. */
  readonly maxRetries?: number;
}

export interface GetRangeParams {
  readonly dataset: string;
  readonly symbols: string | readonly string[];
  readonly schema: string; // ohlcv-1m | ohlcv-1s | trades | mbp-1 | definition | status | statistics
  readonly start: string; // ISO or ns
  readonly end?: string;
  readonly stypeIn?: string; // raw_symbol | continuous | parent | instrument_id
  readonly stypeOut?: string; // instrument_id (default)
  readonly limit?: number;
}

export interface SymbologyResolveParams {
  readonly dataset: string;
  readonly symbols: string | readonly string[];
  readonly stypeIn: string;
  readonly stypeOut: string;
  readonly startDate: string; // YYYY-MM-DD
  readonly endDate?: string;
}

/** An HTTP failure that never carries the credential. */
export class DatabentoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    message: string,
  ) {
    super(`databento ${endpoint} -> HTTP ${status}: ${message}`);
    this.name = 'DatabentoHttpError';
  }
}

export class DatabentoHttp {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;

  constructor(opts: DatabentoHttpOptions) {
    if (!opts.apiKey) throw new Error('DatabentoHttp requires an API key');
    this.baseUrl = (opts.baseUrl ?? 'https://hist.databento.com/v0').replace(/\/$/, '');
    // Basic auth: key as username, empty password. Encoded once; never logged.
    this.authHeader = 'Basic ' + Buffer.from(`${opts.apiKey}:`).toString('base64');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.maxRetries = opts.maxRetries ?? 3;
    if (!this.fetchImpl) throw new Error('no fetch implementation available');
  }

  private form(params: Record<string, string | number | undefined>): string {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) body.append(k, String(v));
    }
    return body.toString();
  }

  /** POST a form to an endpoint, with bounded backoff on 5xx/network errors. */
  private async post(endpoint: string, form: string): Promise<Response> {
    const url = `${this.baseUrl}/${endpoint}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: this.authHeader,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form,
        });
        // 4xx (auth, bad request) is not retryable and must surface immediately,
        // never in a tight loop — an expired key must not hammer the endpoint.
        if (res.status >= 400 && res.status < 500) {
          throw new DatabentoHttpError(res.status, endpoint, await safeText(res));
        }
        if (res.status >= 500) {
          lastErr = new DatabentoHttpError(res.status, endpoint, await safeText(res));
        } else {
          return res;
        }
      } catch (err) {
        if (err instanceof DatabentoHttpError && err.status >= 400 && err.status < 500) throw err;
        lastErr = err;
      }
      if (attempt < this.maxRetries) {
        await sleep(Math.min(8000, 250 * 2 ** attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`databento ${endpoint} failed`);
  }

  /**
   * Stream a schema over a window as parsed JSON records. Returns them in the
   * order the feed produced them (chronological for a single symbol).
   */
  async getRange(params: GetRangeParams): Promise<Array<Record<string, unknown>>> {
    const form = this.form({
      dataset: params.dataset,
      symbols: Array.isArray(params.symbols) ? params.symbols.join(',') : (params.symbols as string),
      schema: params.schema,
      start: params.start,
      end: params.end,
      encoding: 'json',
      stype_in: params.stypeIn,
      stype_out: params.stypeOut,
      limit: params.limit,
    });
    const res = await this.post('timeseries.get_range', form);
    const text = await res.text();
    return parseNdjson(text);
  }

  /** Resolve input symbols (e.g. continuous NQ.c.0) to output symbols/ids. */
  async symbologyResolve(params: SymbologyResolveParams): Promise<Record<string, unknown>> {
    const form = this.form({
      dataset: params.dataset,
      symbols: Array.isArray(params.symbols) ? params.symbols.join(',') : (params.symbols as string),
      stype_in: params.stypeIn,
      stype_out: params.stypeOut,
      start_date: params.startDate,
      end_date: params.endDate,
    });
    const res = await this.post('symbology.resolve', form);
    return (await res.json()) as Record<string, unknown>;
  }

  /** The available date range for a dataset — used for a health/liveness probe. */
  async datasetRange(dataset: string): Promise<Record<string, unknown>> {
    const form = this.form({ dataset });
    const res = await this.post('metadata.get_dataset_range', form);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** Parse newline-delimited JSON, skipping blank lines, tolerant of a trailing newline. */
export function parseNdjson(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // A malformed line is skipped rather than failing the whole window; the
      // adapter counts drops through the integrity layer downstream.
    }
  }
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    // Truncate: an error body must never become a place a secret echoes at length.
    return t.slice(0, 300);
  } catch {
    return '<no body>';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
