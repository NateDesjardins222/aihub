/**
 * Adversarial WebSocket hardening (F-04).
 *
 * The gateway is a push socket every browser tab holds open. Before this it had
 * no frame-size cap (~100 MiB default → memory-exhaustion lever), no inbound
 * message-rate limit (a flood drives DB reads and snapshot builds), and no send
 * backpressure (a slow reader buffers unboundedly on our side). These tests
 * open a real socket against a listening app and prove each lever is closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { buildApp } from '../http/app.js';
import { exceedsBackpressureLimit, MAX_BUFFERED_BYTES } from './gateway.js';

let app: FastifyInstance;
let url: string;

function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve when the socket closes, with its close code. */
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

beforeAll(async () => {
  process.env['DATABASE_URL'] =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
  app = (await buildApp()).app;
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  url = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await app.close();
});

describe('WebSocket hardening', () => {
  it('rejects an oversize frame instead of buffering ~100 MiB', async () => {
    const ws = await open();
    const done = closed(ws);
    // Well over the 64 KiB cap. The server must refuse to read it.
    ws.send(JSON.stringify({ t: 'ping', ts: Date.now(), pad: 'A'.repeat(200_000) }));
    const code = await done;
    // ws closes an over-limit peer with 1009 (message too big); some paths
    // surface 1006. Either way the socket does not stay open having read it.
    expect([1009, 1006]).toContain(code);
  });

  it('throttles a message flood and finally closes the abuser', async () => {
    const ws = await open();
    let rateLimited = false;
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { t: string; code?: string };
      if (frame.t === 'error' && frame.code === 'RATE_LIMITED') rateLimited = true;
    });
    const done = closed(ws);
    // Far above the token-bucket capacity: a burst no legitimate client sends.
    for (let i = 0; i < 400; i += 1) {
      ws.send(JSON.stringify({ t: 'ping', ts: i }));
    }
    const code = await done;
    expect(rateLimited, 'a flood should draw at least one RATE_LIMITED frame').toBe(true);
    expect(code).toBe(4429); // our "message rate exceeded" close code
  });

  it('a well-behaved client is never throttled', async () => {
    const ws = await open();
    let errored = false;
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { t: string; code?: string };
      if (frame.t === 'error' && frame.code === 'RATE_LIMITED') errored = true;
    });
    // A normal cadence: a handful of pings spaced out.
    for (let i = 0; i < 5; i += 1) {
      ws.send(JSON.stringify({ t: 'ping', ts: i }));
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(errored).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('drops a client whose send backlog exceeds the cap (backpressure)', () => {
    // A real slow-consumer socket cannot be made to overflow deterministically
    // over localhost, so the decision raw() makes on every send is tested here
    // directly. Healthy backlog passes; a backlog past the cap is dropped.
    expect(exceedsBackpressureLimit(0)).toBe(false);
    expect(exceedsBackpressureLimit(MAX_BUFFERED_BYTES)).toBe(false);
    expect(exceedsBackpressureLimit(MAX_BUFFERED_BYTES + 1)).toBe(true);
  });
});
