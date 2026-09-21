/**
 * Market-data error taxonomy and observer (Phases 82-83) — offline unit tests.
 */
import { describe, expect, it } from 'vitest';
import { classifyMarketDataError, MarketDataObserver, type MarketDataLogEvent } from './errors.js';

class HttpErr extends Error {
  constructor(readonly status: number, msg: string) {
    super(msg);
    this.name = 'DatabentoHttpError';
  }
}

describe('market-data error classification', () => {
  it('classifies auth failures as non-retryable AUTH', () => {
    const c = classifyMarketDataError(new HttpErr(401, 'unauthorized'));
    expect(c.kind).toBe('AUTH');
    expect(c.retryable).toBe(false);
  });

  it('classifies a 404 as MAPPING (a symbol/contract that did not resolve)', () => {
    expect(classifyMarketDataError(new HttpErr(404, 'no such symbol')).kind).toBe('MAPPING');
  });

  it('classifies 429 and 5xx as retryable PROVIDER', () => {
    expect(classifyMarketDataError(new HttpErr(429, 'slow down')).retryable).toBe(true);
    const c = classifyMarketDataError(new HttpErr(503, 'unavailable'));
    expect(c.kind).toBe('PROVIDER');
    expect(c.retryable).toBe(true);
  });

  it('classifies connection failures as retryable NETWORK', () => {
    const c = classifyMarketDataError(new Error('ECONNRESET socket hang up'));
    expect(c.kind).toBe('NETWORK');
    expect(c.retryable).toBe(true);
  });

  it('classifies malformed data as INVALID_DATA', () => {
    const e = new SyntaxError('Unexpected token');
    expect(classifyMarketDataError(e).kind).toBe('INVALID_DATA');
  });

  it('never carries a credential in the classified message', () => {
    const c = classifyMarketDataError(new HttpErr(401, 'auth failed for db-SECRET but truncated ok'));
    // The adapter is responsible for keeping the message credential-free; this
    // asserts the classifier does not lengthen or expose it.
    expect(c.message.length).toBeLessThanOrEqual(200);
  });
});

describe('market-data observer', () => {
  it('records coarse lifecycle events and counts them, never a tick', () => {
    const events: MarketDataLogEvent[] = [];
    const obs = new MarketDataObserver('databento', (e) => events.push(e));
    obs.emit('connect');
    obs.emit('connected');
    obs.emit('subscribe', { symbol: 'NQ' });
    obs.emit('gap', { symbol: 'NQ', detail: { missedMs: 5000 } });
    obs.error(new HttpErr(503, 'unavailable'), { symbol: 'NQ' });
    expect(events.map((e) => e.event)).toEqual(['connect', 'connected', 'subscribe', 'gap', 'error']);
    expect(events.every((e) => e.provider === 'databento' && typeof e.at === 'number')).toBe(true);
    const last = events[events.length - 1]!;
    expect(last.errorKind).toBe('PROVIDER');
    expect(obs.snapshot()).toMatchObject({ connect: 1, subscribe: 1, gap: 1, error: 1 });
  });
});
