/**
 * Replay provider: plays a recorded real market session back through the same
 * MarketDataProvider interface the live feed uses.
 *
 * The events are exactly what the market produced. Replay controls how fast the
 * clock advances, never what the prices are: at 50x a real 1-minute bar arrives
 * every 1.2 seconds, and no intermediate ticks are invented to fill the gap.
 */
import type {
  ConnectionStatus,
  HistoricalBarsRequest,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
} from '@atlas/contracts';
import { requireInstrument } from '@atlas/instruments';
import type { DescribableProvider, ProviderCapabilities, ProviderEvent, ProviderListener } from '../provider.js';
import { readEvents, readHeader } from '../recorder.js';
import type { RecordedEvent, RecordingHeader } from '../recording.js';

export const REPLAY_SPEEDS = [1, 2, 5, 10, 25, 50] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export interface ReplayState {
  readonly loaded: boolean;
  readonly recordingId: string | null;
  readonly symbol: string | null;
  readonly playing: boolean;
  readonly speed: ReplaySpeed;
  readonly cursor: number;
  readonly total: number;
  /** Exchange timestamp of the event most recently emitted. */
  readonly clock: number | null;
  readonly startTs: number | null;
  readonly endTs: number | null;
  readonly header: RecordingHeader | null;
  readonly progress: number;
}

export class ReplayProvider implements DescribableProvider {
  readonly id = 'replay';
  readonly mode = 'REPLAY' as const;
  readonly depthLevels = 0;

  private readonly listeners = new Set<ProviderListener>();
  private readonly subscribed = new Set<string>();
  private readonly quotes = new Map<string, NormalizedQuote>();
  private readonly tradeBuffer = new Map<string, NormalizedTrade[]>();

  private events: RecordedEvent[] = [];
  private header: RecordingHeader | null = null;
  private recordingId: string | null = null;
  private cursor = 0;
  private playing = false;
  private speed: ReplaySpeed = 1;
  private timer: NodeJS.Timeout | null = null;
  private state: ConnectionStatus['state'] = 'DISCONNECTED';
  private lastEventAt: number | null = null;

  capabilities(): ProviderCapabilities {
    return {
      providesTrades: this.events.some((e) => e.kind === 'trade'),
      providesQuotes: this.events.some((e) => e.kind === 'quote'),
      providesTopOfBook: false,
      providesDepth: false,
      providesOhlcv: true,
      history: [],
      notes: [
        'Replays a recorded real market session. Contains no generated prices.',
        'Bar cadence is the recording’s own cadence, divided by the replay speed.',
      ],
    };
  }

  async connect(): Promise<void> {
    this.state = 'CONNECTED';
    this.emitStatus();
  }

  async disconnect(): Promise<void> {
    this.pause();
    this.state = 'DISCONNECTED';
    this.emitStatus();
  }

  subscribe(symbol: string): void {
    this.subscribed.add(symbol.toUpperCase());
  }
  unsubscribe(symbol: string): void {
    this.subscribed.delete(symbol.toUpperCase());
  }
  subscriptions(): readonly string[] {
    return [...this.subscribed];
  }

  getQuote(symbol: string): NormalizedQuote | null {
    return this.quotes.get(symbol.toUpperCase()) ?? null;
  }
  getTrades(symbol: string): readonly NormalizedTrade[] {
    return this.tradeBuffer.get(symbol.toUpperCase()) ?? [];
  }
  getDepth(): NormalizedDepth | null {
    return null;
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      providerId: this.id,
      state: this.state,
      mode: this.mode,
      delaySeconds: 0,
      declaredDelaySeconds: 0,
      lastEventAt: this.lastEventAt,
      lastMessageAt: this.lastEventAt,
      reconnectAttempts: 0,
    };
  }

  on(listener: ProviderListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Bars already emitted, so a chart attaching mid-replay can draw the history
   * the replay has produced so far without seeing the future.
   */
  async getHistoricalBars(request: HistoricalBarsRequest): Promise<NormalizedBar[]> {
    const symbol = request.symbol.toUpperCase();
    const out: NormalizedBar[] = [];
    for (let i = 0; i < this.cursor && i < this.events.length; i += 1) {
      const event = this.events[i]!;
      if (event.kind === 'bar' && event.data.symbol === symbol) out.push(event.data);
    }
    return out;
  }

  // -- controls ------------------------------------------------------------

  load(path: string, id: string): ReplayState {
    this.pause();
    this.header = readHeader(path);
    this.events = readEvents(path);
    this.recordingId = id;
    this.cursor = 0;
    this.quotes.clear();
    this.tradeBuffer.clear();
    if (this.header) this.subscribed.add(this.header.symbol);
    this.state = 'CONNECTED';
    this.emitStatus();
    return this.getState();
  }

  play(): ReplayState {
    if (!this.header || this.events.length === 0) throw new Error('NO_RECORDING_LOADED');
    if (this.cursor >= this.events.length) this.cursor = 0;
    this.playing = true;
    this.scheduleNext();
    return this.getState();
  }

  pause(): ReplayState {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.getState();
  }

  setSpeed(speed: ReplaySpeed): ReplayState {
    if (!REPLAY_SPEEDS.includes(speed)) throw new Error('UNSUPPORTED_SPEED');
    this.speed = speed;
    if (this.playing) {
      if (this.timer) clearTimeout(this.timer);
      this.scheduleNext();
    }
    return this.getState();
  }

  /** Jump to a fraction of the recording, replaying everything up to it. */
  seek(progress: number): ReplayState {
    const wasPlaying = this.playing;
    this.pause();
    const target = Math.max(0, Math.min(1, progress));
    const index = Math.floor(target * this.events.length);
    this.cursor = 0;
    this.quotes.clear();
    // Fast-forward silently, so state is correct without flooding subscribers.
    for (let i = 0; i < index; i += 1) this.applyEvent(this.events[i]!, false);
    this.cursor = index;
    if (wasPlaying) this.play();
    return this.getState();
  }

  reset(): ReplayState {
    this.pause();
    this.cursor = 0;
    this.quotes.clear();
    this.tradeBuffer.clear();
    return this.getState();
  }

  getState(): ReplayState {
    return {
      loaded: this.header !== null,
      recordingId: this.recordingId,
      symbol: this.header?.symbol ?? null,
      playing: this.playing,
      speed: this.speed,
      cursor: this.cursor,
      total: this.events.length,
      clock: this.lastEventAt,
      startTs: this.header?.startTs ?? null,
      endTs: this.header?.endTs ?? null,
      header: this.header,
      progress: this.events.length === 0 ? 0 : this.cursor / this.events.length,
    };
  }

  // -- engine --------------------------------------------------------------

  /**
   * Schedule the next event using the real gap between recorded timestamps,
   * divided by the speed multiplier. Long market gaps (the maintenance break)
   * are compressed to a bound so a replay does not stall for an hour.
   */
  private scheduleNext(): void {
    if (!this.playing) return;
    if (this.cursor >= this.events.length) {
      this.playing = false;
      this.emitStatus();
      return;
    }

    const current = this.events[this.cursor]!;
    const previous = this.cursor > 0 ? this.events[this.cursor - 1] : undefined;
    const gapMs = previous ? Math.max(0, current.ts - previous.ts) : 0;
    const MAX_GAP_MS = 5 * 60_000;
    const scaled = Math.min(gapMs, MAX_GAP_MS) / this.speed;

    this.timer = setTimeout(
      () => {
        if (!this.playing) return;
        this.applyEvent(current, true);
        this.cursor += 1;
        this.scheduleNext();
      },
      Math.max(0, Math.round(scaled)),
    );
    this.timer.unref?.();
  }

  private applyEvent(event: RecordedEvent, emit: boolean): void {
    this.lastEventAt = event.ts;

    if (event.kind === 'bar') {
      if (emit) this.emit({ kind: 'bar', bar: event.data });
      // A bar close is also a price update, so downstream marking still works
      // for recordings that carry no separate quote stream.
      const spec = requireInstrument(event.data.symbol);
      const quote: NormalizedQuote = {
        symbol: spec.root,
        exchangeTs: event.data.time,
        bid: null,
        bidSize: null,
        ask: null,
        askSize: null,
        last: event.data.close,
        lastSize: null,
        seq: this.cursor,
        synthesizedBook: false,
      };
      this.quotes.set(spec.root, quote);
      if (emit) this.emit({ kind: 'quote', quote });
      return;
    }

    if (event.kind === 'quote') {
      this.quotes.set(event.data.symbol, event.data);
      if (emit) this.emit({ kind: 'quote', quote: event.data });
      return;
    }

    let buffer = this.tradeBuffer.get(event.data.symbol);
    if (!buffer) {
      buffer = [];
      this.tradeBuffer.set(event.data.symbol, buffer);
    }
    buffer.push(event.data);
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
    if (emit) this.emit({ kind: 'trade', trade: event.data });
  }

  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitStatus(): void {
    this.emit({ kind: 'status', status: this.getConnectionStatus() });
  }
}
