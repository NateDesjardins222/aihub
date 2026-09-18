/**
 * WebSocket gateway.
 *
 * One multiplexed socket per browser tab. Market data is pushed, never polled.
 * Every frame is sequenced per stream, heartbeats carry the feed's real status,
 * and a reconnecting client either replays a short gap exactly or is handed a
 * fresh snapshot.
 */
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import type { ClientFrame, ServerFrame, Timeframe } from '@atlas/contracts';
import { getInstrument } from '@atlas/instruments';
import { verifyAccessToken } from '../auth/tokens.js';
import type { MarketDataService } from '../marketdata/service.js';
import type { EngineChange, TradingEngine } from '../trading/engine.js';
import { STREAM, StreamRegistry } from './streams.js';

const HEARTBEAT_MS = 5_000;
/** A socket that has not spoken in this long is considered dead. */
const IDLE_TIMEOUT_MS = 45_000;
const MAX_SUBSCRIPTIONS = 64;

interface Client {
  readonly id: string;
  readonly socket: WebSocket;
  userId: string | null;
  readonly streams: Set<string>;
  /** Accounts this socket has been authorised to follow. */
  readonly accounts: Set<string>;
  lastSeenAt: number;
  alive: boolean;
}

export class MarketDataGateway {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, Client>();
  private readonly registry = new StreamRegistry();
  /** Unsubscribe handles for aggregator/bus listeners, keyed by stream. */
  private readonly sources = new Map<string, () => void>();
  private readonly streamRefCounts = new Map<string, number>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly market: MarketDataService,
    private readonly engine?: TradingEngine,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  register(app: FastifyInstance): void {
    app.server.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/ws')) return;
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    });

    // Status changes are global, so this source is always live.
    this.market.onStatus((status) => this.publish(STREAM.status, status));

    // Trading state is PUSHED. The browser holds a replica and is told when it
    // changes; it never polls for a fill, and never decides it had one.
    this.engine?.onChange((change: EngineChange) => {
      this.publish(`acct.${change.accountId}.orders`, change.orders);
      if (change.position) this.publish(`acct.${change.accountId}.positions`, change.position);
      if (change.fills.length > 0) {
        this.publish(`acct.${change.accountId}.executions`, change.fills);
      }
      if (change.trades.length > 0) {
        this.publish(`acct.${change.accountId}.trades`, change.trades);
      }
    });

    // Account valuations carry the full P&L picture, so the client updates
    // directly from the frame instead of issuing a REST read per push.
    this.engine?.onValuation((valuation) => {
      this.publish(`acct.${valuation.accountId}.pnl`, valuation);
    });

    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.heartbeat.unref?.();

    app.addHook('onClose', async () => this.close());
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients.values()) client.socket.close(1001, 'server shutting down');
    this.clients.clear();
    for (const stop of this.sources.values()) stop();
    this.sources.clear();
    await new Promise<void>((done) => this.wss.close(() => done()));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private accept(socket: WebSocket): void {
    const client: Client = {
      id: randomUUID(),
      socket,
      userId: null,
      streams: new Set(),
      accounts: new Set(),
      lastSeenAt: Date.now(),
      alive: true,
    };
    this.clients.set(client.id, client);

    socket.on('message', (raw) => {
      client.lastSeenAt = Date.now();
      let frame: ClientFrame;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {
        this.send(client, { t: 'error', code: 'BAD_FRAME', message: 'Frame was not valid JSON.' });
        return;
      }
      void this.handle(client, frame);
    });

    socket.on('pong', () => {
      client.alive = true;
      client.lastSeenAt = Date.now();
    });

    socket.on('close', () => this.dropClient(client));
    socket.on('error', () => this.dropClient(client));
  }

  private dropClient(client: Client): void {
    if (!this.clients.has(client.id)) return;
    for (const stream of client.streams) this.releaseStream(stream);
    client.streams.clear();
    this.clients.delete(client.id);
  }

  private async handle(client: Client, frame: ClientFrame): Promise<void> {
    switch (frame.t) {
      case 'hello': {
        const claims = verifyAccessToken(frame.token);
        if (!claims) {
          this.send(client, { t: 'error', code: 'UNAUTHORIZED', message: 'Invalid access token.' });
          client.socket.close(4401, 'unauthorized');
          return;
        }
        client.userId = claims.sub;
        this.send(client, {
          t: 'welcome',
          serverTime: Date.now(),
          sessionId: client.id,
          userId: claims.sub,
          protocolVersion: 1,
        });
        return;
      }

      case 'ping': {
        this.send(client, { t: 'pong', ts: frame.ts, serverTime: Date.now() });
        return;
      }

      case 'subscribe': {
        if (!client.userId) {
          this.send(client, { t: 'error', code: 'UNAUTHORIZED', message: 'Send hello first.' });
          return;
        }
        for (const stream of frame.channels) {
          if (stream.startsWith('acct.') && !(await this.mayFollowAccount(client, stream))) {
            this.send(client, {
              t: 'error',
              code: 'FORBIDDEN',
              message: 'That account does not belong to you.',
            });
            continue;
          }
          if (client.streams.size >= MAX_SUBSCRIPTIONS) {
            this.send(client, {
              t: 'error',
              code: 'TOO_MANY_SUBSCRIPTIONS',
              message: `A socket may hold at most ${MAX_SUBSCRIPTIONS} streams.`,
            });
            break;
          }
          if (client.streams.has(stream)) continue;
          const ok = await this.ensureStream(stream);
          if (!ok) {
            this.send(client, {
              t: 'error',
              code: 'UNKNOWN_STREAM',
              message: `Cannot subscribe to ${stream}.`,
            });
            continue;
          }
          client.streams.add(stream);
          await this.sendSnapshot(client, stream);
        }
        return;
      }

      case 'unsubscribe': {
        for (const stream of frame.channels) {
          if (!client.streams.delete(stream)) continue;
          this.releaseStream(stream);
        }
        return;
      }

      case 'bars': {
        const stream = STREAM.bar(frame.symbol.toUpperCase(), frame.timeframe);
        if (frame.action === 'subscribe') {
          await this.handle(client, { t: 'subscribe', channels: [stream] });
        } else {
          await this.handle(client, { t: 'unsubscribe', channels: [stream] });
        }
        return;
      }

      case 'resume': {
        const replay = this.registry.replayFrom(frame.stream, frame.lastSeq);
        if (replay === null) {
          // The gap is longer than the buffer: a snapshot is the only honest answer.
          await this.sendSnapshot(client, frame.stream);
          return;
        }
        for (const buffered of replay) {
          this.send(client, {
            t: 'delta',
            stream: frame.stream,
            seq: buffered.seq,
            serverTime: Date.now(),
            data: buffered.data,
          });
        }
        return;
      }
    }
  }

  /** Attach a data source for a stream the first time anyone subscribes. */
  private async ensureStream(stream: string): Promise<boolean> {
    this.streamRefCounts.set(stream, (this.streamRefCounts.get(stream) ?? 0) + 1);
    if (this.sources.has(stream) || stream === STREAM.status) return this.isKnownStream(stream);

    const bar = this.registry.parseBarStream(stream);
    if (bar) {
      const spec = getInstrument(bar.symbol);
      if (!spec) return false;
      await this.market.subscribe(spec.root);
      const off = this.market.onBar(spec.root, bar.timeframe, (update) => {
        this.publish(stream, update.bar);
      });
      this.sources.set(stream, () => {
        off();
        this.market.unsubscribe(spec.root);
      });
      return true;
    }

    const quoteSymbol = this.registry.parseSymbolStream(stream, 'quote');
    if (quoteSymbol) {
      const spec = getInstrument(quoteSymbol);
      if (!spec) return false;
      await this.market.subscribe(spec.root);
      const off = this.market.onQuote(spec.root, (quote) => this.publish(stream, quote));
      this.sources.set(stream, () => {
        off();
        this.market.unsubscribe(spec.root);
      });
      return true;
    }

    // Account streams carry no server-side source: the engine pushes into them
    // directly. They still have to be recognised so a client may subscribe.
    if (stream.startsWith('acct.')) {
      this.sources.set(stream, () => undefined);
      return true;
    }

    const depthSymbol = this.registry.parseSymbolStream(stream, 'depth');
    if (depthSymbol) {
      const spec = getInstrument(depthSymbol);
      if (!spec) return false;
      const off = this.market.bus.onDepth(spec.root, (depth) => this.publish(stream, depth));
      this.sources.set(stream, off);
      return true;
    }

    this.streamRefCounts.delete(stream);
    return false;
  }

  private isKnownStream(stream: string): boolean {
    if (stream === STREAM.status) return true;
    if (stream.startsWith('acct.')) return true;
    if (this.registry.parseBarStream(stream)) return true;
    for (const kind of ['quote', 'trade', 'depth'] as const) {
      if (this.registry.parseSymbolStream(stream, kind)) return true;
    }
    return false;
  }

  private releaseStream(stream: string): void {
    const count = (this.streamRefCounts.get(stream) ?? 1) - 1;
    if (count > 0) {
      this.streamRefCounts.set(stream, count);
      return;
    }
    this.streamRefCounts.delete(stream);
    const stop = this.sources.get(stream);
    if (stop) {
      stop();
      this.sources.delete(stream);
    }
  }

  /**
   * May this socket follow an account stream?
   *
   * Account streams carry positions, fills and balances. Without this check any
   * authenticated user could subscribe to `acct.<someone-else's-id>.pnl` simply
   * by guessing an id.
   */
  private async mayFollowAccount(client: Client, stream: string): Promise<boolean> {
    if (!client.userId) return false;
    const accountId = stream.split('.')[1];
    if (!accountId) return false;
    if (client.accounts.has(accountId)) return true;

    const { db } = await import('../db/client.js').then((m) => ({ db: m.getDb().db }));
    const { accounts } = await import('../db/schema.js');
    const { and, eq } = await import('drizzle-orm');
    const [row] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.userId, client.userId)));
    if (!row) return false;
    client.accounts.add(accountId);
    return true;
  }

  /** Authoritative current state for a stream. Replaces the client's copy. */
  private async sendSnapshot(client: Client, stream: string): Promise<void> {
    const seq = this.registry.current(stream);

    if (stream === STREAM.status) {
      this.send(client, {
        t: 'snapshot',
        stream,
        seq,
        serverTime: Date.now(),
        data: this.market.getConnectionStatus(),
      });
      return;
    }

    const bar = this.registry.parseBarStream(stream);
    if (bar) {
      const page = await this.market.getChartBars({
        symbol: bar.symbol,
        timeframe: bar.timeframe as Timeframe,
        limit: 1,
      });
      this.send(client, {
        t: 'snapshot',
        stream,
        seq,
        serverTime: Date.now(),
        data: page.bars[page.bars.length - 1] ?? null,
      });
      return;
    }

    const quoteSymbol = this.registry.parseSymbolStream(stream, 'quote');
    if (quoteSymbol) {
      this.send(client, {
        t: 'snapshot',
        stream,
        seq,
        serverTime: Date.now(),
        data: this.market.getQuote(quoteSymbol),
      });
      return;
    }

    // Account streams are seeded by the REST read APIs, which the client calls
    // on connect; a null here would tell it it has no orders.
    this.send(client, { t: 'snapshot', stream, seq, serverTime: Date.now(), data: null });
  }

  private publish(stream: string, data: unknown): void {
    const frame = this.registry.next(stream, data);
    /*
     * `observedAt` rides on the frame so the browser can measure the half of
     * the path the server cannot see - wire, store, render, paint - against
     * the same instant the server measured its own half against. Without it
     * the client could only compare against its own clock, which is not the
     * server's.
     */
    const timing =
      data !== null && typeof data === 'object' ? this.market.bus.latency.timingFor(data) : null;
    const payload: ServerFrame = {
      t: 'delta',
      stream,
      seq: frame.seq,
      serverTime: Date.now(),
      ...(timing ? { observedAt: timing.observedAt } : {}),
      data,
    };
    const encoded = JSON.stringify(payload);
    for (const client of this.clients.values()) {
      if (!client.streams.has(stream)) continue;
      this.raw(client, encoded);
    }
    if (data !== null && typeof data === 'object') this.market.bus.latency.markSent(data);
  }

  private tick(): void {
    const now = Date.now();
    const status = this.market.getConnectionStatus();

    for (const client of this.clients.values()) {
      if (now - client.lastSeenAt > IDLE_TIMEOUT_MS) {
        client.socket.terminate();
        this.dropClient(client);
        continue;
      }
      if (client.socket.readyState === client.socket.OPEN) {
        client.socket.ping();
        this.send(client, {
          t: 'heartbeat',
          serverTime: now,
          marketData: status,
          backlog: this.market.bus.getStats().published,
        });
      }
    }
  }

  private send(client: Client, frame: ServerFrame): void {
    this.raw(client, JSON.stringify(frame));
  }

  private raw(client: Client, encoded: string): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    try {
      client.socket.send(encoded);
    } catch {
      this.dropClient(client);
    }
  }
}
