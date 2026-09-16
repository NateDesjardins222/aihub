/**
 * Stream naming and per-stream sequencing.
 *
 * Every server frame carries a monotonic sequence number scoped to its stream,
 * which is what lets a reconnecting client tell "I missed nothing" from "I am
 * now silently out of date". A small ring buffer lets short gaps be replayed
 * exactly; anything longer is answered with an authoritative snapshot instead.
 */
import type { Timeframe } from '@atlas/contracts';

export const STREAM = {
  quote: (symbol: string): string => `md.quote.${symbol}`,
  trade: (symbol: string): string => `md.trade.${symbol}`,
  bar: (symbol: string, tf: Timeframe): string => `md.bar.${symbol}.${tf}`,
  depth: (symbol: string): string => `md.depth.${symbol}`,
  status: 'md.status',
  heartbeat: 'sys.heartbeat',
} as const;

export interface BufferedFrame {
  readonly seq: number;
  readonly data: unknown;
  readonly at: number;
}

export class StreamRegistry {
  private readonly seqs = new Map<string, number>();
  private readonly buffers = new Map<string, BufferedFrame[]>();

  constructor(private readonly bufferSize = 256) {}

  next(stream: string, data: unknown): BufferedFrame {
    const seq = (this.seqs.get(stream) ?? 0) + 1;
    this.seqs.set(stream, seq);

    let buffer = this.buffers.get(stream);
    if (!buffer) {
      buffer = [];
      this.buffers.set(stream, buffer);
    }
    const frame: BufferedFrame = { seq, data, at: Date.now() };
    buffer.push(frame);
    if (buffer.length > this.bufferSize) buffer.splice(0, buffer.length - this.bufferSize);
    return frame;
  }

  current(stream: string): number {
    return this.seqs.get(stream) ?? 0;
  }

  /**
   * Frames after `lastSeq`, or null when the gap is larger than the buffer and
   * the client must be re-snapshotted rather than patched.
   */
  replayFrom(stream: string, lastSeq: number): BufferedFrame[] | null {
    const buffer = this.buffers.get(stream);
    if (!buffer || buffer.length === 0) return lastSeq === this.current(stream) ? [] : null;
    const oldest = buffer[0]!.seq;
    if (lastSeq + 1 < oldest) return null;
    return buffer.filter((f) => f.seq > lastSeq);
  }

  parseBarStream(stream: string): { symbol: string; timeframe: Timeframe } | null {
    const parts = stream.split('.');
    if (parts.length !== 4 || parts[0] !== 'md' || parts[1] !== 'bar') return null;
    return { symbol: parts[2]!, timeframe: parts[3] as Timeframe };
  }

  parseSymbolStream(stream: string, kind: 'quote' | 'trade' | 'depth'): string | null {
    const prefix = `md.${kind}.`;
    if (!stream.startsWith(prefix)) return null;
    const symbol = stream.slice(prefix.length);
    return symbol.length > 0 ? symbol : null;
  }
}
