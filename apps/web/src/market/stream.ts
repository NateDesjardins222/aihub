/**
 * Client-side market stream.
 *
 * THIS DELIBERATELY LIVES OUTSIDE REACT.
 *
 * Quotes and bars arrive several times a second. Routing them through React
 * state would re-render the component tree on every tick and make the chart
 * stutter. Instead this module owns a WebSocket and a plain callback registry;
 * the chart adapter and the legend subscribe directly and write to the canvas
 * or to DOM nodes they already hold references to.
 *
 * React is told only about things that change rarely: connection status,
 * selected symbol, selected timeframe.
 */
import type {
  ConnectionStatus,
  NormalizedBar,
  NormalizedQuote,
  ServerFrame,
  Timeframe,
} from '@atlas/contracts';
import { getAccessToken } from '../api/client';
import { clientLatency } from './latency';

type Listener<T> = (value: T) => void;

export interface StreamDiagnostics {
  readonly connected: boolean;
  readonly reconnectAttempts: number;
  /** Round-trip latency to the server, milliseconds. */
  readonly latencyMs: number | null;
  /** Server clock minus client clock, used to interpret exchange timestamps. */
  readonly clockSkewMs: number | null;
  readonly framesReceived: number;
  readonly gapsRecovered: number;
  readonly lastFrameAt: number | null;
  readonly marketData: ConnectionStatus | null;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const PING_INTERVAL_MS = 10_000;

/**
 * The symbol a market stream is about, or null for a stream that is not about
 * one. `md.quote.NQ` -> `NQ`.
 */
function symbolOfStream(stream: string): string | null {
  if (!stream.startsWith('md.')) return null;
  const parts = stream.split('.');
  return parts.length >= 3 ? (parts[2] ?? null) : null;
}

export class MarketStream {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;

  /** Streams this client wants, so they can be re-established on reconnect. */
  private readonly desired = new Set<string>();
  /** Last sequence seen per stream, so a reconnect can ask to resume. */
  private readonly lastSeq = new Map<string, number>();

  private readonly barListeners = new Map<string, Set<Listener<NormalizedBar>>>();
  private readonly quoteListeners = new Map<string, Set<Listener<NormalizedQuote>>>();
  private readonly rawListeners = new Map<string, Set<Listener<unknown>>>();
  private readonly statusListeners = new Set<Listener<ConnectionStatus>>();
  private readonly diagListeners = new Set<Listener<StreamDiagnostics>>();

  private diagnostics: StreamDiagnostics = {
    connected: false,
    reconnectAttempts: 0,
    latencyMs: null,
    clockSkewMs: null,
    framesReceived: 0,
    gapsRecovered: 0,
    lastFrameAt: null,
    marketData: null,
  };

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const token = getAccessToken();
    if (!token) return;

    this.closedByUs = false;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({ t: 'hello', token, clientId: 'web', protocolVersion: 1 }),
      );
      // Re-establish every stream, resuming where possible so a short drop
      // does not force a full reload of the chart.
      if (this.desired.size > 0) {
        socket.send(JSON.stringify({ t: 'subscribe', channels: [...this.desired] }));
        for (const [stream, seq] of this.lastSeq) {
          socket.send(JSON.stringify({ t: 'resume', stream, lastSeq: seq }));
        }
      }
      this.reconnectAttempts = 0;
      this.updateDiagnostics({ connected: true, reconnectAttempts: 0 });
      this.startPing();
    };

    socket.onmessage = (event) => this.onFrame(event.data as string);

    socket.onclose = () => {
      this.stopPing();
      this.updateDiagnostics({ connected: false });
      if (!this.closedByUs) this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows, which is where reconnection is handled.
    };
  }

  disconnect(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.updateDiagnostics({ connected: false });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    // Exponential backoff with jitter, so a server restart does not produce a
    // synchronised stampede from every open tab.
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1));
    const delay = backoff * (0.7 + Math.random() * 0.6);
    this.updateDiagnostics({ reconnectAttempts: this.reconnectAttempts });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onFrame(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    this.diagnostics = {
      ...this.diagnostics,
      framesReceived: this.diagnostics.framesReceived + 1,
      lastFrameAt: Date.now(),
    };

    switch (frame.t) {
      case 'welcome':
        this.updateDiagnostics({ clockSkewMs: frame.serverTime - Date.now() });
        return;

      case 'pong': {
        const rtt = Date.now() - frame.ts;
        this.updateDiagnostics({
          latencyMs: rtt,
          clockSkewMs: frame.serverTime - (frame.ts + rtt / 2),
        });
        return;
      }

      case 'heartbeat':
        this.updateDiagnostics({ marketData: frame.marketData });
        for (const listener of this.statusListeners) listener(frame.marketData);
        return;

      case 'snapshot': {
        // A snapshot replaces local state for that stream outright.
        this.lastSeq.set(frame.stream, frame.seq);
        this.updateDiagnostics({ gapsRecovered: this.diagnostics.gapsRecovered + 1 });
        this.dispatch(frame.stream, frame.data);
        return;
      }

      case 'delta': {
        const previous = this.lastSeq.get(frame.stream);
        if (previous !== undefined && frame.seq > previous + 1) {
          // A gap means we are missing events; ask for authoritative state
          // rather than carrying on with a series that has holes in it.
          this.send({ t: 'resume', stream: frame.stream, lastSeq: previous });
        }
        this.lastSeq.set(frame.stream, frame.seq);
        // Start the browser's half of the latency measurement before the
        // payload is dispatched, so the dispatch itself is inside it.
        const symbol = symbolOfStream(frame.stream);
        if (symbol) clientLatency.received(symbol, frame.observedAt);
        this.dispatch(frame.stream, frame.data);
        return;
      }

      case 'error':
        // Surfaced through diagnostics rather than thrown: a single bad stream
        // must not tear down the socket.
        return;
    }
  }

  private dispatch(stream: string, data: unknown): void {
    // Raw subscribers are notified even for an empty payload: for account
    // streams the signal is "state changed", not the payload itself.
    const raw = this.rawListeners.get(stream);
    if (raw) for (const listener of raw) listener(data);

    if (data === null || data === undefined) return;

    if (stream.startsWith('md.bar.')) {
      const listeners = this.barListeners.get(stream);
      if (listeners) for (const listener of listeners) listener(data as NormalizedBar);
      return;
    }
    if (stream.startsWith('md.quote.')) {
      const listeners = this.quoteListeners.get(stream);
      if (listeners) for (const listener of listeners) listener(data as NormalizedQuote);
      return;
    }
    if (stream === 'md.status') {
      for (const listener of this.statusListeners) listener(data as ConnectionStatus);
    }
  }

  // -- subscriptions -------------------------------------------------------

  subscribeBars(symbol: string, timeframe: Timeframe, listener: Listener<NormalizedBar>): () => void {
    const stream = `md.bar.${symbol}.${timeframe}`;
    return this.addListener(this.barListeners, stream, listener as Listener<unknown>) as () => void;
  }

  subscribeQuote(symbol: string, listener: Listener<NormalizedQuote>): () => void {
    const stream = `md.quote.${symbol}`;
    return this.addListener(this.quoteListeners, stream, listener as Listener<unknown>) as () => void;
  }

  /**
   * Subscribe to any stream by name.
   *
   * Used for account channels, whose payloads the market stream does not need
   * to understand: the trading store treats a frame as "something changed" and
   * re-reads authoritative state from the REST API rather than trusting the
   * frame's contents.
   */
  subscribeRaw(stream: string, listener: Listener<unknown>): () => void {
    return this.addListener(this.rawListeners, stream, listener);
  }

  subscribeStatus(listener: Listener<ConnectionStatus>): () => void {
    this.statusListeners.add(listener);
    this.want('md.status');
    return () => this.statusListeners.delete(listener);
  }

  subscribeDiagnostics(listener: Listener<StreamDiagnostics>): () => void {
    this.diagListeners.add(listener);
    listener(this.diagnostics);
    return () => this.diagListeners.delete(listener);
  }

  getDiagnostics(): StreamDiagnostics {
    return this.diagnostics;
  }

  private addListener<T>(
    registry: Map<string, Set<Listener<T>>>,
    stream: string,
    listener: Listener<T>,
  ): () => void {
    let set = registry.get(stream);
    if (!set) {
      set = new Set();
      registry.set(stream, set);
    }
    set.add(listener);
    this.want(stream);

    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        registry.delete(stream);
        this.unwant(stream);
      }
    };
  }

  private want(stream: string): void {
    if (this.desired.has(stream)) return;
    this.desired.add(stream);
    this.send({ t: 'subscribe', channels: [stream] });
  }

  private unwant(stream: string): void {
    if (!this.desired.delete(stream)) return;
    this.lastSeq.delete(stream);
    this.send({ t: 'unsubscribe', channels: [stream] });
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private updateDiagnostics(patch: Partial<StreamDiagnostics>): void {
    this.diagnostics = { ...this.diagnostics, ...patch };
    for (const listener of this.diagListeners) listener(this.diagnostics);
  }
}

/** One stream per tab. */
export const marketStream = new MarketStream();
