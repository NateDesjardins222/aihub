/**
 * A single Rithmic plant connection (Milestone 9).
 *
 * One logical connection to one R | Protocol infrastructure type (TICKER / ORDER /
 * HISTORY / PNL / REPOSITORY), with an explicit state machine, login, heartbeat
 * liveness and bounded reconnect. A socket being OPEN is never enough to be
 * AUTHENTICATED or healthy: that requires a successful login and recent protocol
 * activity. Credentials are held only to build the login frame and never appear
 * in state, metrics, errors or logs.
 */
import { rithmicCodec, type RithmicCodec, type DecodedMessage } from '../protocol/codec.js';
import { MessageRouter } from '../protocol/router.js';
import { HeartbeatWatchdog, backoffDelayMs, mayRetry, type BackoffPolicy, DEFAULT_BACKOFF } from '../../infra/connection-lifecycle.js';
import type { RithmicTransport, TransportFactory } from '../transport/transport.js';
import { rithmicMetrics } from '../metrics.js';

export type PlantKind = 'DISCOVERY' | 'TICKER' | 'ORDER' | 'HISTORY' | 'PNL' | 'REPOSITORY';

export type PlantState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'DEGRADED'
  | 'RECONNECTING'
  | 'FAILED'
  | 'STOPPED';

export type LoginErrorCode =
  | 'AUTH_FAILED'
  | 'SYSTEM_UNAVAILABLE'
  | 'AGREEMENT_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'TRANSPORT_ERROR'
  | 'PROTOCOL_ERROR'
  | 'UNKNOWN';

export class RithmicLoginError extends Error {
  constructor(readonly code: LoginErrorCode, message: string, readonly rpCode?: string) {
    super(message);
    this.name = 'RithmicLoginError';
  }
}

/** SysInfraType name per plant, resolved from the schema (never a hardcoded number). */
const INFRA_TYPE_NAME: Partial<Record<PlantKind, string>> = {
  TICKER: 'TICKER_PLANT',
  ORDER: 'ORDER_PLANT',
  HISTORY: 'HISTORY_PLANT',
  PNL: 'PNL_PLANT',
  REPOSITORY: 'REPOSITORY_PLANT',
};

export interface PlantLogin {
  readonly user: string;
  readonly password: string;
  readonly systemName: string;
  readonly appName: string;
  readonly appVersion: string;
}

export interface PlantOptions {
  readonly kind: PlantKind;
  readonly url: string;
  readonly login?: PlantLogin; // absent for DISCOVERY
  readonly transportFactory: TransportFactory;
  readonly codec?: RithmicCodec;
  readonly backoff?: BackoffPolicy;
  readonly heartbeatIntervalMs?: number;
  readonly livenessTimeoutMs?: number;
  readonly now?: () => number;
  /** Called after a successful (re)authentication, to restore subscriptions/reconcile. */
  readonly onAuthenticated?: (plant: RithmicPlant) => void | Promise<void>;
  /** Scheduler seam so tests drive timers deterministically. */
  readonly scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (h: unknown) => void;
  };
}

export interface PlantMetrics {
  connectedAt: number | null;
  authenticatedAt: number | null;
  lastMessageAt: number | null;
  lastHeartbeatSentAt: number | null;
  lastHeartbeatReceivedAt: number | null;
  reconnectCount: number;
  lastDisconnectReason: string | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  messagesReceived: number;
  decodeErrors: number;
}

export class RithmicPlant {
  readonly kind: PlantKind;
  readonly router = new MessageRouter();
  private readonly codec: RithmicCodec;
  private readonly backoff: BackoffPolicy;
  private hbIntervalMs: number;
  private readonly watchdog: HeartbeatWatchdog;
  private readonly now: () => number;
  private readonly scheduler: NonNullable<PlantOptions['scheduler']>;

  private transport: RithmicTransport | null = null;
  private unsub: Array<() => void> = [];
  private state: PlantState = 'DISCONNECTED';
  private attempts = 0;
  private stopped = false;
  private hbTimer: unknown = null;
  private reconnectTimer: unknown = null;
  private readonly metrics: PlantMetrics = {
    connectedAt: null, authenticatedAt: null, lastMessageAt: null,
    lastHeartbeatSentAt: null, lastHeartbeatReceivedAt: null, reconnectCount: 0,
    lastDisconnectReason: null, lastErrorCode: null, lastErrorAt: null,
    messagesReceived: 0, decodeErrors: 0,
  };

  constructor(private readonly opts: PlantOptions) {
    this.kind = opts.kind;
    this.codec = opts.codec ?? rithmicCodec();
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.hbIntervalMs = opts.heartbeatIntervalMs ?? 20_000;
    this.watchdog = new HeartbeatWatchdog(opts.livenessTimeoutMs ?? this.hbIntervalMs * 3);
    this.now = opts.now ?? (() => Date.now());
    this.scheduler = opts.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
  }

  getState(): PlantState { return this.state; }
  getMetrics(): Readonly<PlantMetrics> { return { ...this.metrics }; }
  isAuthenticated(): boolean { return this.state === 'AUTHENTICATED'; }

  /** Healthy = authenticated AND recent protocol activity (never just an open socket). */
  isHealthy(): boolean {
    return this.state === 'AUTHENTICATED' && !this.watchdog.isStale(this.now());
  }

  /** Connect the transport, authenticate (if configured), start heartbeats. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connectOnce();
  }

  private async connectOnce(): Promise<void> {
    rithmicMetrics.inc('connection_attempts');
    this.setState('CONNECTING');
    const transport = this.opts.transportFactory(this.opts.url);
    this.transport = transport;
    this.wire(transport);
    try {
      await transport.connect();
    } catch (e) {
      this.metrics.lastErrorCode = 'TRANSPORT_ERROR';
      this.metrics.lastErrorAt = this.now();
      this.setState('CONNECTING'); // will fall to reconnect
      this.scheduleReconnect(`connect failed: ${(e as Error).message}`);
      return;
    }
    this.metrics.connectedAt = this.now();
    this.setState('CONNECTED');
    this.watchdog.feed(this.now());
    if (this.opts.login) {
      try {
        await this.login(this.opts.login);
      } catch (e) {
        const code = e instanceof RithmicLoginError ? e.code : 'UNKNOWN';
        this.metrics.lastErrorCode = code;
        this.metrics.lastErrorAt = this.now();
        // A hard auth failure is terminal; a transient one reconnects.
        rithmicMetrics.inc('auth_failure');
        if (code === 'AUTH_FAILED' || code === 'PERMISSION_DENIED' || code === 'AGREEMENT_REQUIRED') {
          this.setState('FAILED');
          try { transport.close(); } catch { /* ignore */ }
          throw e;
        }
        this.scheduleReconnect(`login failed: ${code}`);
        return;
      }
    } else {
      this.setState('AUTHENTICATED'); // discovery needs no login
    }
    if (this.opts.login && this.state === 'AUTHENTICATED') rithmicMetrics.inc('auth_success');
    this.attempts = 0;
    this.startHeartbeat();
    if (this.opts.onAuthenticated) await this.opts.onAuthenticated(this);
  }

  private wire(transport: RithmicTransport): void {
    this.unsub.forEach((u) => u());
    this.unsub = [
      transport.onMessage((data) => this.onMessage(data)),
      transport.onClose((info) => this.onClose(info)),
      transport.onError((err) => this.onError(err)),
    ];
  }

  private onMessage(data: Buffer): void {
    this.metrics.messagesReceived += 1;
    this.metrics.lastMessageAt = this.now();
    this.watchdog.feed(this.now());
    if (this.kind === 'TICKER') rithmicMetrics.inc('market_messages');
    let decoded: DecodedMessage;
    try {
      decoded = this.codec.decode(data);
    } catch {
      this.metrics.decodeErrors += 1;
      rithmicMetrics.inc('decode_failures');
      return; // never throw out of the message pump
    }
    if (decoded.name === 'ResponseHeartbeat' || decoded.name === 'RequestHeartbeat') {
      this.metrics.lastHeartbeatReceivedAt = this.now();
    }
    // A server heartbeat request must be answered.
    if (decoded.name === 'RequestHeartbeat') this.sendHeartbeat();
    this.router.route(decoded);
  }

  private onClose(info: { code: number; reason: string }): void {
    this.metrics.lastDisconnectReason = `${info.code} ${info.reason}`.slice(0, 200);
    if (this.stopped) { this.setState('STOPPED'); return; }
    // A deliberate terminal FAILED (e.g. hard auth rejection) closed the socket;
    // never reconnect a payout/auth that the venue authoritatively refused.
    if (this.state === 'FAILED') return;
    this.scheduleReconnect(this.metrics.lastDisconnectReason);
  }

  private onError(err: Error): void {
    this.metrics.lastErrorCode = 'TRANSPORT_ERROR';
    this.metrics.lastErrorAt = this.now();
    this.metrics.lastDisconnectReason = err.message.slice(0, 200);
  }

  // -- login ------------------------------------------------------------------
  private login(login: PlantLogin): Promise<void> {
    const infraName = INFRA_TYPE_NAME[this.kind];
    const infraType = infraName ? this.codec.enumValue('RequestLogin', 'SysInfraType', infraName) : undefined;
    this.setState('AUTHENTICATING');
    const corr = `login-${this.kind}-${this.now()}`;
    return new Promise<void>((resolve, reject) => {
      const timeout = this.scheduler.setTimeout(() => {
        cancel();
        reject(new RithmicLoginError('TIMEOUT', 'login timed out'));
      }, 15_000);
      const cancel = this.router.awaitCorrelation(corr, (msg) => {
        this.scheduler.clearTimeout(timeout);
        const rp = firstRpCode(msg.message);
        if (rp === '0' || rp === null) {
          const hb = Number(msg.message?.['heartbeat_interval']);
          if (Number.isFinite(hb) && hb > 0) this.applyServerHeartbeat(hb);
          this.metrics.authenticatedAt = this.now();
          this.setState('AUTHENTICATED');
          resolve();
        } else {
          reject(mapLoginError(rp, rpText(msg.message)));
        }
      });
      // Also accept a bare ResponseLogin without correlation echo (some plants).
      const off = this.router.on('ResponseLogin', (msg) => {
        this.scheduler.clearTimeout(timeout);
        cancel(); off();
        const rp = firstRpCode(msg.message);
        if (rp === '0' || rp === null) {
          const hb = Number(msg.message?.['heartbeat_interval']);
          if (Number.isFinite(hb) && hb > 0) this.applyServerHeartbeat(hb);
          this.metrics.authenticatedAt = this.now();
          this.setState('AUTHENTICATED');
          resolve();
        } else {
          reject(mapLoginError(rp, rpText(msg.message)));
        }
      });
      try {
        this.sendRaw('RequestLogin', {
          user: login.user,
          password: login.password,
          system_name: login.systemName,
          app_name: login.appName,
          app_version: login.appVersion,
          template_version: '3.9',
          user_msg: [corr],
          ...(infraType !== undefined ? { infra_type: infraType } : {}),
        });
      } catch (e) {
        this.scheduler.clearTimeout(timeout);
        cancel(); off();
        reject(new RithmicLoginError('PROTOCOL_ERROR', (e as Error).message));
      }
    });
  }

  private applyServerHeartbeat(seconds: number): void {
    // Server dictates the heartbeat cadence; honor it (min 1s guard).
    this.hbIntervalMs = Math.max(1, seconds) * 1000;
  }

  // -- heartbeat --------------------------------------------------------------
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const tick = (): void => {
      if (this.state !== 'AUTHENTICATED' && this.state !== 'DEGRADED') return;
      if (this.watchdog.isStale(this.now())) {
        this.setState('DEGRADED');
        this.scheduleReconnect('liveness timeout (no recent protocol activity)');
        return;
      }
      this.sendHeartbeat();
      this.hbTimer = this.scheduler.setTimeout(tick, this.hbIntervalMs);
    };
    this.hbTimer = this.scheduler.setTimeout(tick, this.hbIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer) { this.scheduler.clearTimeout(this.hbTimer); this.hbTimer = null; }
  }

  private sendHeartbeat(): void {
    try {
      const secs = Math.floor(this.now() / 1000);
      this.sendRaw('RequestHeartbeat', { ssboe: secs, usecs: 0 });
      this.metrics.lastHeartbeatSentAt = this.now();
    } catch { /* a failed heartbeat send surfaces via close/error */ }
  }

  // -- reconnect --------------------------------------------------------------
  private scheduleReconnect(reason: string): void {
    this.stopHeartbeat();
    try { this.transport?.close(); } catch { /* ignore */ }
    if (this.stopped) { this.setState('STOPPED'); return; }
    this.attempts += 1;
    if (!mayRetry(this.backoff, this.attempts)) {
      this.setState('FAILED');
      this.metrics.lastDisconnectReason = `giving up after ${this.attempts} attempts: ${reason}`;
      return;
    }
    this.metrics.reconnectCount += 1;
    rithmicMetrics.inc('reconnects');
    this.setState('RECONNECTING');
    const delay = withJitter(backoffDelayMs(this.backoff, this.attempts));
    this.reconnectTimer = this.scheduler.setTimeout(() => { void this.connectOnce(); }, delay);
  }

  /** Send a message by name (used by plant-specific services). */
  send(name: string, payload: Record<string, unknown>): void {
    this.sendRaw(name, payload);
  }

  private sendRaw(name: string, payload: Record<string, unknown>): void {
    if (!this.transport?.isOpen()) throw new Error(`plant ${this.kind} transport not open`);
    this.transport.send(this.codec.encode(name, payload));
  }

  /** Request/response helper: send and await the first message of `responseName`. */
  request(name: string, payload: Record<string, unknown>, responseName: string, timeoutMs = 15_000): Promise<DecodedMessage> {
    return new Promise((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => { off(); reject(new Error(`${responseName} timed out`)); }, timeoutMs);
      const off = this.router.on(responseName, (msg) => {
        this.scheduler.clearTimeout(timer); off(); resolve(msg);
      });
      try { this.sendRaw(name, payload); } catch (e) { this.scheduler.clearTimeout(timer); off(); reject(e as Error); }
    });
  }

  stop(): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) { this.scheduler.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.transport?.close(); } catch { /* ignore */ }
    this.setState('STOPPED');
  }

  private stateListeners = new Set<(s: PlantState) => void>();
  onStateChange(cb: (s: PlantState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }
  private setState(s: PlantState): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.stateListeners) { try { cb(s); } catch { /* ignore */ } }
  }
}

function withJitter(ms: number): number {
  if (ms <= 0) return 0;
  return Math.round(ms * (0.5 + Math.random() * 0.5)); // 50–100% of the delay
}

function firstRpCode(message: Record<string, unknown> | null | undefined): string | null {
  const rp = message?.['rp_code'];
  if (Array.isArray(rp) && rp.length > 0) return String(rp[0]);
  if (typeof rp === 'string') return rp;
  return null;
}

function rpText(message: Record<string, unknown> | null | undefined): string {
  const rp = message?.['rp_code'];
  if (Array.isArray(rp)) return rp.map(String).join(' ');
  return String(rp ?? '');
}

/** Map a Rithmic rp_code / text to a canonical login error without losing the code. */
export function mapLoginError(rpCode: string, text: string): RithmicLoginError {
  const t = `${rpCode} ${text}`.toLowerCase();
  let code: LoginErrorCode = 'UNKNOWN';
  if (/agreement|not signed|accept/.test(t)) code = 'AGREEMENT_REQUIRED';
  else if (/password|user|login|credential|invalid|authenticat/.test(t)) code = 'AUTH_FAILED';
  else if (/permission|not authorized|entitle|denied/.test(t)) code = 'PERMISSION_DENIED';
  else if (/system|unavailable|not found|no such/.test(t)) code = 'SYSTEM_UNAVAILABLE';
  else if (/timeout|timed out/.test(t)) code = 'TIMEOUT';
  return new RithmicLoginError(code, `login rejected (rp_code=${rpCode})`, rpCode);
}
