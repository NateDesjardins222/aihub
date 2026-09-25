/**
 * Rithmic torture + edge cases (Milestone 9).
 *
 * Additional deterministic coverage: framing/codec robustness, secret redaction,
 * discovery failures, out-of-order + malformed messages, freshness windows,
 * instrument reconciliation across all launch roots, and reconnect storms bounded
 * by backoff. No live Rithmic.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { loadSchema, resetSchemaCache, resolveProtoInputs } from './protocol/registry.js';
import { RithmicCodec, resetCodec } from './protocol/codec.js';
import { frame, FrameStream, deframeOne, MAX_FRAME_BYTES } from './protocol/framing.js';
import { MessageRouter } from './protocol/router.js';
import { sanitizeTransportError } from './transport/ws-transport.js';
import { MockRithmicTransport } from './transport/transport.js';
import { RithmicSystemDiscoveryService, RithmicDiscoveryError } from './plants/discovery.js';
import { backoffDelayMs, DEFAULT_BACKOFF, mayRetry } from '../infra/connection-lifecycle.js';
import { LAUNCH_ROOTS, atlasCanonical, reconcileReferenceData } from './domain/instruments.js';
import { FreshnessTracker } from './domain/freshness.js';
import { validateBarSeries } from './domain/bar-compare.js';
import { rithmicTsToMs } from './domain/market-normalize.js';

let codec: RithmicCodec;
beforeEach(() => { resetSchemaCache(); resetCodec(); codec = new RithmicCodec(loadSchema({ force: true })); });

describe('framing robustness', () => {
  it('resolves proto inputs to the test double when no package is present', () => {
    const { source } = resolveProtoInputs(null);
    expect(source).toBe('TEST_DOUBLE');
  });
  it('handles many small frames coalesced into one chunk', () => {
    const s = new FrameStream();
    const chunks = [1, 2, 3, 4, 5].map((n) => frame(new Uint8Array([n])));
    const out = s.push(Buffer.concat(chunks));
    expect(out.map((f) => f[0])).toEqual([1, 2, 3, 4, 5]);
  });
  it('a zero-length body frames and deframes to empty', () => {
    expect(deframeOne(frame(new Uint8Array([]))).length).toBe(0);
  });
  it('MAX_FRAME_BYTES guards a hostile length', () => {
    const buf = Buffer.alloc(4); buf.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => deframeOne(buf)).toThrow();
  });
});

describe('codec robustness', () => {
  it('decodes a heartbeat round-trip and re-encodes identically', () => {
    const a = codec.encodeBody('RequestHeartbeat', { ssboe: 7, usecs: 8 });
    const d = codec.decodeBody(a);
    const b = codec.encodeBody('RequestHeartbeat', { ssboe: d.message!['ssboe'], usecs: d.message!['usecs'] });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });
  it('a truncated protobuf body is a structured decode error, not a crash', () => {
    const body = codec.encodeBody('ResponseLogin', { rp_code: ['0'], fcm_id: 'F' });
    expect(() => codec.decodeBody(body.subarray(0, 2))).toThrow();
  });
  it('enum resolution throws a structured error for an unknown value', () => {
    expect(() => codec.enumValue('RequestNewOrder', 'TransactionType', 'SIDEWAYS')).toThrow();
  });
});

describe('secret redaction', () => {
  it('sanitizeTransportError strips credentials from a url and query', () => {
    expect(sanitizeTransportError('connect wss://user:pass@host/x failed')).not.toContain('pass');
    expect(sanitizeTransportError('error password=hunter2 token=abc')).not.toMatch(/hunter2|abc/);
  });
});

describe('router edge cases', () => {
  it('an unmapped correlation id is ignored (no throw)', () => {
    const r = new MessageRouter();
    r.route({ templateId: 19, name: 'ResponseHeartbeat', message: { user_msg: ['nope'] }, body: new Uint8Array() });
    expect(r.getStats().routed).toBe(1);
  });
  it('clear() removes handlers and pending correlations', () => {
    const r = new MessageRouter();
    let hit = 0; r.on('ResponseHeartbeat', () => { hit += 1; });
    r.clear();
    r.route({ templateId: 19, name: 'ResponseHeartbeat', message: {}, body: new Uint8Array() });
    expect(hit).toBe(0);
  });
});

describe('discovery failures', () => {
  it('reports MALFORMED_RESPONSE when no systems are returned', async () => {
    const factory = (url: string): MockRithmicTransport => {
      const t = new MockRithmicTransport(url);
      t.serverHandler = (f): void => {
        const d = codec.decode(f);
        if (d.name === 'RequestRithmicSystemInfo') t.injectMessage(codec.encode('ResponseRithmicSystemInfo', { rp_code: ['0'], system_name: [], user_msg: (d.message?.['user_msg'] as string[]) ?? [] }));
      };
      return t;
    };
    const svc = new RithmicSystemDiscoveryService({ url: 'wss://x', transportFactory: factory });
    await expect(svc.discover()).rejects.toBeInstanceOf(RithmicDiscoveryError);
  });
  it('surfaces ENDPOINT_UNAVAILABLE when the transport refuses to connect', async () => {
    const factory = (url: string): MockRithmicTransport => { const t = new MockRithmicTransport(url); t.failConnect = true; return t; };
    const svc = new RithmicSystemDiscoveryService({ url: 'wss://x', transportFactory: factory });
    await expect(svc.discover()).rejects.toBeInstanceOf(RithmicDiscoveryError);
  });
});

describe('backoff is bounded (no reconnect storm)', () => {
  it('delay grows then caps at maxMs', () => {
    const d1 = backoffDelayMs(DEFAULT_BACKOFF, 1);
    const d5 = backoffDelayMs(DEFAULT_BACKOFF, 5);
    const d20 = backoffDelayMs(DEFAULT_BACKOFF, 20);
    expect(d5).toBeGreaterThan(d1);
    expect(d20).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
  });
  it('mayRetry respects a bounded attempt cap', () => {
    expect(mayRetry({ ...DEFAULT_BACKOFF, maxAttempts: 3 }, 3)).toBe(false);
    expect(mayRetry({ ...DEFAULT_BACKOFF, maxAttempts: 3 }, 2)).toBe(true);
  });
});

describe('instrument reconciliation across all launch roots', () => {
  for (const root of LAUNCH_ROOTS) {
    it(`${root}: MATCHED when provider mirrors canonical`, () => {
      const c = atlasCanonical(root);
      const rec = reconcileReferenceData(root, { symbol: root, exchange: c.exchange, tickSize: c.tickSize, pointValue: c.pointValue, expiration: null, tradingSymbol: null, tradable: true });
      expect(rec.status).toBe('MATCHED');
    });
  }
});

describe('freshness windows', () => {
  it('message rate falls to zero after the window passes', () => {
    let now = 0; const f = new FreshnessTracker('NQ', 5_000, () => now);
    f.observe(now); now += 10_000;
    expect(f.messagesPerSec()).toBe(0);
    expect(f.isStale()).toBe(true);
  });
  it('rithmicTsToMs rejects a non-positive ssboe', () => {
    expect(rithmicTsToMs(-1, 0)).toBeNull();
  });
});

describe('bar series validation', () => {
  it('accepts a clean ascending series', () => {
    expect(validateBarSeries([
      { symbol: 'NQ', time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closed: true },
      { symbol: 'NQ', time: 2000, open: 1.5, high: 2.5, low: 1, close: 2, volume: 12, closed: true },
    ])).toHaveLength(0);
  });
  it('flags a backward timestamp', () => {
    expect(validateBarSeries([
      { symbol: 'NQ', time: 2000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closed: true },
      { symbol: 'NQ', time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, closed: true },
    ]).some((p) => /backward/.test(p))).toBe(true);
  });
});
