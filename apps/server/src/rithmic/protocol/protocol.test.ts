/**
 * R | Protocol layer — deterministic tests (Milestone 9).
 *
 * These exercise framing, the schema/template registry, the codec and the router
 * against the committed test-double schema using real protobufjs encode/decode —
 * no live Rithmic, no network. They prove the wire machinery is internally
 * consistent and fails safely on malformed input.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { frame, deframeOne, FrameStream, FramingError, LENGTH_PREFIX_BYTES } from './framing.js';
import { loadSchema, buildRegistry, resetSchemaCache } from './registry.js';
import { RithmicCodec, CodecError, readTemplateId } from './codec.js';
import { MessageRouter } from './router.js';

let codec: RithmicCodec;

beforeAll(() => {
  resetSchemaCache();
  codec = new RithmicCodec(loadSchema({ force: true }));
});

describe('framing', () => {
  it('round-trips a body through frame → deframeOne', () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const framed = frame(body);
    expect(framed.length).toBe(LENGTH_PREFIX_BYTES + body.length);
    expect(framed.readUInt32BE(0)).toBe(5);
    expect(Array.from(deframeOne(framed))).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a truncated frame', () => {
    expect(() => deframeOne(Buffer.from([0, 0, 0, 10, 1, 2]))).toThrow(FramingError);
  });

  it('rejects a frame that is shorter than the prefix', () => {
    expect(() => deframeOne(Buffer.from([0, 0]))).toThrow(FramingError);
  });

  it('rejects an over-large declared length', () => {
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(0xffffffff, 0);
    expect(() => deframeOne(buf)).toThrow(/FRAME_TOO_LARGE|exceeds/);
  });

  it('FrameStream reassembles frames split across chunks', () => {
    const s = new FrameStream();
    const a = frame(new Uint8Array([10, 20]));
    const b = frame(new Uint8Array([30, 40, 50]));
    const stream = Buffer.concat([a, b]);
    // Deliver 3 bytes at a time.
    const got: number[][] = [];
    for (let i = 0; i < stream.length; i += 3) {
      for (const f of s.push(stream.subarray(i, i + 3))) got.push(Array.from(f));
    }
    expect(got).toEqual([[10, 20], [30, 40, 50]]);
    expect(s.pending()).toBe(0);
  });

  it('FrameStream holds a partial frame without yielding', () => {
    const s = new FrameStream();
    const f = frame(new Uint8Array([1, 2, 3, 4]));
    expect(s.push(f.subarray(0, 5))).toEqual([]); // prefix + 1 byte
    expect(s.pending()).toBeGreaterThan(0);
    const rest = s.push(f.subarray(5));
    expect(rest.map((x) => Array.from(x))).toEqual([[1, 2, 3, 4]]);
  });
});

describe('schema + template registry', () => {
  it('loads the test-double schema and derives template ids from it', () => {
    const s = loadSchema({ force: true });
    expect(s.source).toBe('TEST_DOUBLE');
    expect(s.nameToId.get('RequestLogin')).toBe(10);
    expect(s.nameToId.get('ResponseLogin')).toBe(11);
    expect(s.nameToId.get('RequestRithmicSystemInfo')).toBe(16);
    expect(s.idToName.get(150)).toMatch(/LastTrade$/);
  });

  it('id<->name is a consistent bijection for known messages', () => {
    const s = loadSchema({ force: true });
    for (const [name, id] of s.nameToId) {
      const full = s.idToName.get(id);
      expect(full, `id ${id} for ${name}`).toBeTruthy();
      expect(full!.endsWith(name)).toBe(true);
    }
  });

  it('does not hardcode ids — a rebuilt registry matches the schema defaults', () => {
    const s = loadSchema({ force: true });
    const rebuilt = buildRegistry(s.root, s.source);
    expect(rebuilt.nameToId.get('RequestNewOrder')).toBe(s.nameToId.get('RequestNewOrder'));
  });
});

describe('codec', () => {
  it('encodes and decodes a login round-trip with the template id set from the registry', () => {
    const wire = codec.encode('RequestLogin', {
      user: 'u', password: 'p', system_name: 'Rithmic Test', app_name: 'Atlas', app_version: '9.0.0', infra_type: 1,
    });
    const decoded = codec.decode(wire);
    expect(decoded.name).toBe('RequestLogin');
    expect(decoded.templateId).toBe(10);
    expect(decoded.message!['system_name']).toBe('Rithmic Test');
    expect(decoded.message!['infra_type']).toBe(1);
  });

  it('encodes a LastTrade and decodes correct numeric fields', () => {
    const wire = codec.encode('LastTrade', { symbol: 'NQZ5', exchange: 'CME', trade_price: 20123.25, trade_size: 3, ssboe: 1700000000, usecs: 123456 });
    const d = codec.decode(wire);
    expect(d.message!['trade_price']).toBeCloseTo(20123.25, 6);
    expect(d.message!['trade_size']).toBe(3);
    expect(d.message!['symbol']).toBe('NQZ5');
  });

  it('reads the template id straight off a body without the schema', () => {
    const body = codec.encodeBody('RequestHeartbeat', { ssboe: 1, usecs: 2 });
    expect(readTemplateId(body, 154467)).toBe(18);
  });

  it('routes an unknown template id safely instead of throwing', () => {
    // Hand-build a frame whose template_id is not in the registry.
    const fake = codec.encodeBody('RequestHeartbeat', {});
    // Rewrite: instead, decode a body with an unmapped id by encoding then flipping.
    // Simplest: craft a minimal protobuf with field 154467 = 99999 (varint).
    const parts: number[] = [];
    // tag for field 154467, wire 0
    let tag = (154467 << 3) | 0;
    while (tag > 0x7f) { parts.push((tag & 0x7f) | 0x80); tag >>>= 7; }
    parts.push(tag);
    let v = 99999;
    while (v > 0x7f) { parts.push((v & 0x7f) | 0x80); v >>>= 7; }
    parts.push(v);
    const d = codec.decodeBody(new Uint8Array(parts));
    expect(d.templateId).toBe(99999);
    expect(d.name).toBeNull();
    expect(d.message).toBeNull();
    void fake;
  });

  it('throws NO_TEMPLATE_ID on a body with no template_id field', () => {
    expect(() => codec.decodeBody(new Uint8Array([]))).toThrow(CodecError);
  });

  it('throws UNKNOWN_MESSAGE when encoding a name not in the schema', () => {
    expect(() => codec.encode('NotARealMessage', {})).toThrow(CodecError);
  });
});

describe('router', () => {
  it('dispatches decoded messages to name handlers', () => {
    const router = new MessageRouter();
    const seen: string[] = [];
    router.on('ResponseLogin', (m) => seen.push(String(m.message!['fcm_id'])));
    const wire = codec.encode('ResponseLogin', { rp_code: ['0'], fcm_id: 'FCM1', heartbeat_interval: 30 });
    router.route(codec.decode(wire));
    expect(seen).toEqual(['FCM1']);
    expect(router.getStats().routed).toBe(1);
  });

  it('sends unmapped templates to the unknown sink', () => {
    const router = new MessageRouter();
    let unknownId = 0;
    router.onUnknown((id) => { unknownId = id; });
    router.route({ templateId: 88888, name: null, message: null, body: new Uint8Array() });
    expect(unknownId).toBe(88888);
    expect(router.getStats().unknown).toBe(1);
  });

  it('resolves a correlation waiter by echoed user_msg', () => {
    const router = new MessageRouter();
    let resolved: string | null = null;
    router.awaitCorrelation('corr-1', (m) => { resolved = String(m.message!['account_id']); });
    const wire = codec.encode('ResponseAccountList', { rp_code: ['0'], account_id: 'ACC-9', user_msg: ['corr-1'] } as Record<string, unknown>);
    router.route(codec.decode(wire));
    expect(resolved).toBe('ACC-9');
  });

  it('isolates a throwing handler', () => {
    const router = new MessageRouter();
    router.on('ResponseHeartbeat', () => { throw new Error('boom'); });
    let ok = false;
    router.on('ResponseHeartbeat', () => { ok = true; });
    router.route(codec.decode(codec.encode('ResponseHeartbeat', { ssboe: 1, usecs: 2 })));
    expect(ok).toBe(true);
    expect(router.getStats().handlerErrors).toBe(1);
  });
});
