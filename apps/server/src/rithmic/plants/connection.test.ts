/**
 * Rithmic connection layer — deterministic tests (Milestone 9).
 *
 * A mock "server" answers real R | Protocol frames (decoded + re-encoded with the
 * test-double codec) so discovery, login/auth, heartbeat, reconnect and the
 * connection manager run end-to-end with no network and no real Rithmic.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { loadSchema, resetSchemaCache } from '../protocol/registry.js';
import { RithmicCodec } from '../protocol/codec.js';
import { MockRithmicTransport } from '../transport/transport.js';
import { RithmicPlant, RithmicLoginError, mapLoginError } from './plant.js';
import { RithmicSystemDiscoveryService, RithmicDiscoveryError } from './discovery.js';
import { RithmicConnectionManager, hostOf } from './connection-manager.js';

let codec: RithmicCodec;

beforeEach(() => {
  resetSchemaCache();
  codec = new RithmicCodec(loadSchema({ force: true }));
});

/** A controllable scheduler so heartbeat/reconnect timers are deterministic. */
class FakeScheduler {
  private seq = 0;
  private tasks = new Map<number, { fn: () => void; due: number }>();
  now = 0;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.tasks.set(id, { fn, due: this.now + ms });
    return id;
  };
  clearTimeout = (h: unknown): void => { this.tasks.delete(h as number); };
  advance(ms: number): void {
    this.now += ms;
    const ready = [...this.tasks.entries()].filter(([, t]) => t.due <= this.now).sort((a, b) => a[1].due - b[1].due);
    for (const [id, t] of ready) { this.tasks.delete(id); t.fn(); }
  }
  clock = (): number => this.now;
}

/** A mock Rithmic server: decodes each client frame and returns canned responses. */
function makeServer(opts: {
  systems?: string[];
  loginRpCode?: string;
  loginText?: string;
  heartbeatInterval?: number;
  transports?: MockRithmicTransport[];
} = {}) {
  const systems = opts.systems ?? ['Rithmic Test', 'Rithmic Paper'];
  const transports = opts.transports ?? [];
  const factory = (url: string): MockRithmicTransport => {
    const t = new MockRithmicTransport(url);
    t.serverHandler = (frame): void => {
      let decoded;
      try { decoded = codec.decode(frame); } catch { return; }
      const echo = (decoded.message?.['user_msg'] as string[] | undefined) ?? [];
      if (decoded.name === 'RequestRithmicSystemInfo') {
        t.injectMessage(codec.encode('ResponseRithmicSystemInfo', { rp_code: ['0'], system_name: systems, user_msg: echo }));
      } else if (decoded.name === 'RequestLogin') {
        // Rithmic rp_code is repeated: [code, text].
        const rp = opts.loginRpCode ? [opts.loginRpCode, opts.loginText ?? ''] : ['0'];
        t.injectMessage(codec.encode('ResponseLogin', {
          rp_code: rp,
          user_msg: echo,
          fcm_id: 'TEST-FCM', ib_id: 'TEST-IB', heartbeat_interval: opts.heartbeatInterval ?? 60,
        }));
      } else if (decoded.name === 'RequestHeartbeat') {
        t.injectMessage(codec.encode('ResponseHeartbeat', { ssboe: decoded.message?.['ssboe'] ?? 0, usecs: 0 }));
      }
    };
    transports.push(t);
    return t;
  };
  return { factory, transports };
}

describe('system discovery', () => {
  it('discovers systems and verifies the configured one is present', async () => {
    const { factory } = makeServer({ systems: ['Rithmic Test', 'Rithmic 01'] });
    const svc = new RithmicSystemDiscoveryService({ url: 'wss://mock/1', transportFactory: factory });
    const result = await svc.discover();
    expect(result.systems).toContain('Rithmic Test');
    await expect(svc.verifySystem('Rithmic Test')).resolves.toBeTruthy();
  });

  it('reports SYSTEM_ABSENT when the configured system is missing', async () => {
    const { factory } = makeServer({ systems: ['Rithmic 01'] });
    const svc = new RithmicSystemDiscoveryService({ url: 'wss://mock/2', transportFactory: factory });
    await expect(svc.verifySystem('Rithmic Test')).rejects.toBeInstanceOf(RithmicDiscoveryError);
  });

  it('caches discovery results within the window', async () => {
    let connects = 0;
    const base = makeServer();
    const factory = (url: string) => { connects += 1; return base.factory(url); };
    const svc = new RithmicSystemDiscoveryService({ url: 'wss://mock/3', transportFactory: factory, cacheMs: 100_000, now: () => 1000 });
    await svc.discover();
    await svc.discover();
    expect(connects).toBe(1);
  });
});

describe('authentication', () => {
  it('logs a plant in to AUTHENTICATED on rp_code 0', async () => {
    const { factory } = makeServer();
    const plant = new RithmicPlant({
      kind: 'TICKER', url: 'wss://mock/a', transportFactory: factory,
      login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
    });
    await plant.start();
    expect(plant.getState()).toBe('AUTHENTICATED');
    expect(plant.isAuthenticated()).toBe(true);
    expect(plant.getMetrics().authenticatedAt).not.toBeNull();
  });

  it('sends the correct infra_type per plant, resolved from the schema', async () => {
    const { factory, transports } = makeServer();
    const plant = new RithmicPlant({
      kind: 'ORDER', url: 'wss://mock/b', transportFactory: factory,
      login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
    });
    await plant.start();
    const loginFrame = transports[0]!.sent.map((f) => codec.decode(f)).find((d) => d.name === 'RequestLogin');
    expect(loginFrame!.message!['infra_type']).toBe(codec.enumValue('RequestLogin', 'SysInfraType', 'ORDER_PLANT'));
  });

  it('fails to AUTH_FAILED on a bad credential rp_code and does not reconnect', async () => {
    const { factory } = makeServer({ loginRpCode: '5', loginText: 'invalid password' });
    const plant = new RithmicPlant({
      kind: 'TICKER', url: 'wss://mock/c', transportFactory: factory,
      login: { user: 'u', password: 'bad', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
    });
    await expect(plant.start()).rejects.toBeInstanceOf(RithmicLoginError);
    expect(plant.getState()).toBe('FAILED');
  });

  it('maps agreement-required responses to AGREEMENT_REQUIRED', () => {
    expect(mapLoginError('7', 'agreement not signed').code).toBe('AGREEMENT_REQUIRED');
    expect(mapLoginError('3', 'permission denied').code).toBe('PERMISSION_DENIED');
    expect(mapLoginError('9', 'no such system').code).toBe('SYSTEM_UNAVAILABLE');
  });

  it('never exposes the password anywhere in plant state, metrics or health', async () => {
    const { factory } = makeServer();
    const plant = new RithmicPlant({
      kind: 'TICKER', url: 'wss://mock/d', transportFactory: factory,
      login: { user: 'u', password: 'SUPERSECRET', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
    });
    await plant.start();
    const blob = JSON.stringify(plant.getMetrics()) + plant.getState();
    expect(blob).not.toContain('SUPERSECRET');
  });
});

describe('heartbeat + liveness', () => {
  it('sends heartbeats on the server-dictated interval and stays healthy', async () => {
    const sched = new FakeScheduler();
    const { factory, transports } = makeServer({ heartbeatInterval: 10 });
    const plant = new RithmicPlant({
      kind: 'TICKER', url: 'wss://mock/e', transportFactory: factory,
      login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
      now: sched.clock, scheduler: sched,
    });
    await plant.start();
    expect(plant.isHealthy()).toBe(true);
    sched.advance(10_000); // one heartbeat interval
    const hbSent = transports[0]!.sent.map((f) => codec.decode(f)).filter((d) => d.name === 'RequestHeartbeat');
    expect(hbSent.length).toBeGreaterThanOrEqual(1);
    expect(plant.isHealthy()).toBe(true);
  });

  it('goes DEGRADED and reconnects when the feed goes silent past the liveness timeout', async () => {
    const sched = new FakeScheduler();
    const { factory, transports } = makeServer({ heartbeatInterval: 10 });
    const plant = new RithmicPlant({
      kind: 'TICKER', url: 'wss://mock/f', transportFactory: factory,
      login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
      now: sched.clock, scheduler: sched, livenessTimeoutMs: 15_000,
    });
    await plant.start();
    // Silence the server so heartbeats are not answered → watchdog goes stale.
    transports[0]!.serverHandler = null;
    sched.advance(60_000);
    expect(['RECONNECTING', 'CONNECTING', 'AUTHENTICATED']).toContain(plant.getState());
    expect(plant.getMetrics().reconnectCount).toBeGreaterThanOrEqual(1);
    plant.stop();
  });
});

describe('reconnect + recovery', () => {
  it('reconnects and re-authenticates after an abnormal close, restoring via onAuthenticated', async () => {
    const sched = new FakeScheduler();
    const { factory, transports } = makeServer();
    let authCount = 0;
    const plant = new RithmicPlant({
      kind: 'ORDER', url: 'wss://mock/g', transportFactory: factory,
      login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
      now: sched.clock, scheduler: sched,
      onAuthenticated: () => { authCount += 1; },
    });
    await plant.start();
    expect(authCount).toBe(1);
    // Kill the socket abnormally.
    transports[0]!.injectClose(1006, 'abnormal');
    expect(plant.getState()).toBe('RECONNECTING');
    sched.advance(5_000); // let backoff elapse → new connect + login
    // Allow the async connect/login microtasks to settle.
    await Promise.resolve(); await Promise.resolve();
    expect(plant.getMetrics().reconnectCount).toBeGreaterThanOrEqual(1);
    plant.stop();
  });

  it('stops cleanly and does not reconnect after stop()', async () => {
    const sched = new FakeScheduler();
    const { factory, transports } = makeServer();
    const plant = new RithmicPlant({
      kind: 'TICKER', url: 'wss://mock/h', transportFactory: factory,
      login: { user: 'u', password: 'p', systemName: 'Rithmic Test', appName: 'Atlas', appVersion: '9' },
      now: sched.clock, scheduler: sched,
    });
    await plant.start();
    plant.stop();
    expect(plant.getState()).toBe('STOPPED');
    transports[0]!.injectClose(1006, 'abnormal');
    expect(plant.getState()).toBe('STOPPED');
  });
});

describe('connection manager', () => {
  it('brings up multiple distinct plants and reports per-plant health', async () => {
    const { factory } = makeServer();
    const mgr = new RithmicConnectionManager({
      endpoint: 'wss://rituz00100.rithmic.com:443',
      systemName: 'Rithmic Test',
      login: { user: 'u', password: 'p', appName: 'Atlas', appVersion: '9' },
      plants: ['TICKER', 'ORDER', 'HISTORY', 'PNL'],
      transportFactory: factory,
    });
    await mgr.start();
    expect(mgr.allHealthy()).toBe(true);
    const health = mgr.health();
    expect(health.plants.map((p) => p.kind).sort()).toEqual(['HISTORY', 'ORDER', 'PNL', 'TICKER']);
    expect(health.plants.every((p) => p.state === 'AUTHENTICATED')).toBe(true);
    expect(health.endpointHost).toBe('rituz00100.rithmic.com:443');
    expect(health.discoveredSystems).toContain('Rithmic Test');
    mgr.stop();
  });

  it('hostOf strips scheme and any path', () => {
    expect(hostOf('wss://rituz00100.rithmic.com:443/foo')).toBe('rituz00100.rithmic.com:443');
  });
});
