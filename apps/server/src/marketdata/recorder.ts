/**
 * Captures real market sessions to disk for replay.
 *
 * Two capture paths, both of which record only genuine market data:
 *   - LIVE_STREAM: tees the market event bus while the feed is running;
 *   - HISTORICAL_BARS: fetches a past session's real bars from the provider.
 *
 * The second is what makes the simulation engine testable outside market hours,
 * which is the stated reason replay exists.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { InstrumentSpec, NormalizedBar, Timeframe } from '@atlas/contracts';
import { requireInstrument, sessionEnd, tradingDate } from '@atlas/instruments';
import { sessionOpenForTradingDate } from '@atlas/core';
import type { MarketDataProvider } from './provider.js';
import type { MarketEventBus } from './bus.js';
import {
  RECORDING_FORMAT_VERSION,
  encodeLine,
  type RecordedEvent,
  type RecordingHeader,
  type RecordingSummary,
} from './recording.js';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function recordingId(symbol: string, tradingDateStr: string, method: string): string {
  return `${symbol}-${tradingDateStr}-${method === 'LIVE_STREAM' ? 'live' : 'hist'}`;
}

export class SessionRecorder {
  private stop: (() => void) | null = null;
  private events = 0;

  constructor(private readonly dir: string) {
    ensureDir(dir);
  }

  get recording(): boolean {
    return this.stop !== null;
  }

  /** Tee the live bus to disk until stopRecording() is called. */
  startRecording(bus: MarketEventBus, symbol: string, providerId: string): string {
    if (this.stop) throw new Error('ALREADY_RECORDING');
    const spec = requireInstrument(symbol);
    const date = tradingDate(spec, Date.now());
    const id = recordingId(spec.root, date, 'LIVE_STREAM');
    const path = join(this.dir, `${id}.jsonl`);
    const stream = createWriteStream(path, { flags: 'w' });

    const startTs = Date.now();
    this.events = 0;

    const offQuote = bus.onQuote(spec.root, (quote) => {
      stream.write(encodeLine({ ts: quote.exchangeTs, kind: 'quote', data: quote }));
      this.events += 1;
    });
    const offBar = bus.onBar(spec.root, (bar) => {
      stream.write(encodeLine({ ts: bar.time, kind: 'bar', data: bar }));
      this.events += 1;
    });
    const offTrade = bus.onTrade(spec.root, (trade) => {
      stream.write(encodeLine({ ts: trade.exchangeTs, kind: 'trade', data: trade }));
      this.events += 1;
    });

    this.stop = () => {
      offQuote();
      offBar();
      offTrade();
      // The header is appended last, because the event count is only known now.
      const header: RecordingHeader = {
        format: 'atlas-market-recording',
        version: RECORDING_FORMAT_VERSION,
        symbol: spec.root,
        providerId,
        captureMethod: 'LIVE_STREAM',
        baseTimeframe: '1m',
        exchange: spec.exchange,
        sessionTimezone: spec.sessionTimezone,
        startTs,
        endTs: Date.now(),
        tradingDate: date,
        eventCount: this.events,
        createdAt: Date.now(),
        notes: 'Captured live from the delayed provider. Contains only real market events.',
      };
      stream.write(encodeLine(header));
      stream.end();
      this.stop = null;
    };

    return path;
  }

  stopRecording(): void {
    this.stop?.();
  }

  /**
   * Build a replay file from a past session's real historical bars.
   *
   * `date` is an exchange trading date (YYYY-MM-DD). The captured window is that
   * date's whole Globex session, which starts the previous evening.
   */
  async captureHistoricalSession(
    provider: MarketDataProvider,
    symbol: string,
    date: string,
    timeframe: Timeframe = '1m',
  ): Promise<RecordingSummary> {
    const spec = requireInstrument(symbol);
    const from = sessionOpenForTradingDate(spec, date);
    const to = sessionEnd(spec, from + 3_600_000) ?? from + 23 * 3_600_000;

    const bars = await provider.getHistoricalBars({ symbol: spec.root, timeframe, from, to });
    if (bars.length === 0) {
      throw new Error(`NO_DATA_FOR_SESSION: ${spec.root} ${date}`);
    }

    const id = recordingId(spec.root, date, 'HISTORICAL_BARS');
    const path = join(this.dir, `${id}.jsonl`);
    const stream = createWriteStream(path, { flags: 'w' });

    const header: RecordingHeader = {
      format: 'atlas-market-recording',
      version: RECORDING_FORMAT_VERSION,
      symbol: spec.root,
      providerId: provider.id,
      captureMethod: 'HISTORICAL_BARS',
      baseTimeframe: timeframe,
      exchange: spec.exchange,
      sessionTimezone: spec.sessionTimezone,
      startTs: bars[0]!.time,
      endTs: bars[bars.length - 1]!.time,
      tradingDate: date,
      eventCount: bars.length,
      createdAt: Date.now(),
      notes:
        'Real historical OHLCV for one exchange session. No interpolation: replay emits ' +
        'exactly these bars at their real cadence, scaled by the replay speed.',
    };
    stream.write(encodeLine(header));

    for (const bar of bars) {
      // Each bar is emitted at its CLOSE, which is when it became known.
      const event: RecordedEvent = { ts: bar.time, kind: 'bar', data: bar };
      stream.write(encodeLine(event));
    }

    await new Promise<void>((done, fail) => {
      stream.end(() => done());
      stream.on('error', fail);
    });

    return { id, path, header, sizeBytes: statSync(path).size };
  }

  list(): RecordingSummary[] {
    ensureDir(this.dir);
    const out: RecordingSummary[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(this.dir, file);
      const header = readHeader(path);
      if (header) {
        out.push({ id: basename(file, '.jsonl'), path, header, sizeBytes: statSync(path).size });
      }
    }
    return out.sort((a, b) => b.header.startTs - a.header.startTs);
  }

  pathFor(id: string): string {
    // Reject traversal: recording ids are opaque names, never paths.
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error('INVALID_RECORDING_ID');
    }
    const path = resolve(join(this.dir, `${id}.jsonl`));
    if (!path.startsWith(resolve(this.dir))) throw new Error('INVALID_RECORDING_ID');
    return path;
  }
}

/** Read a recording's header, which may be the first or the last line. */
export function readHeader(path: string): RecordingHeader | null {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    for (const candidate of [lines[0], lines[lines.length - 1]]) {
      if (!candidate) continue;
      const parsed = JSON.parse(candidate) as Partial<RecordingHeader>;
      if (parsed.format === 'atlas-market-recording') return parsed as RecordingHeader;
    }
  } catch {
    return null;
  }
  return null;
}

export function readEvents(path: string): RecordedEvent[] {
  const out: RecordedEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RecordedEvent | RecordingHeader;
      if ((parsed as RecordingHeader).format === 'atlas-market-recording') continue;
      out.push(parsed as RecordedEvent);
    } catch {
      // A truncated final line from an interrupted recording: skip it rather
      // than failing the whole replay.
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function sessionBoundsFor(spec: InstrumentSpec, bars: readonly NormalizedBar[]): {
  from: number;
  to: number;
} {
  const from = bars[0]?.time ?? 0;
  const to = bars[bars.length - 1]?.time ?? 0;
  void spec;
  return { from, to };
}
