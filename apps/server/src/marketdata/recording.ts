/**
 * Recorded-session format.
 *
 * A recording is newline-delimited JSON. Every line is one normalized market
 * event with the exchange timestamp it actually carried. There is no synthetic
 * content: a recording can only contain events that really occurred, either
 * captured live from a provider or fetched from real historical bars.
 */
import type { NormalizedBar, NormalizedQuote, NormalizedTrade } from '@atlas/contracts';

export const RECORDING_FORMAT_VERSION = 1;

export interface RecordingHeader {
  readonly format: 'atlas-market-recording';
  readonly version: number;
  readonly symbol: string;
  readonly providerId: string;
  /** Exactly how the events in this file were obtained. */
  readonly captureMethod: 'LIVE_STREAM' | 'HISTORICAL_BARS';
  readonly baseTimeframe: string;
  readonly exchange: string;
  readonly sessionTimezone: string;
  /** Exchange timestamps of the first and last event, epoch ms. */
  readonly startTs: number;
  readonly endTs: number;
  readonly tradingDate: string;
  readonly eventCount: number;
  readonly createdAt: number;
  readonly notes: string;
}

export type RecordedEvent =
  | { readonly ts: number; readonly kind: 'bar'; readonly data: NormalizedBar }
  | { readonly ts: number; readonly kind: 'quote'; readonly data: NormalizedQuote }
  | { readonly ts: number; readonly kind: 'trade'; readonly data: NormalizedTrade };

export interface RecordingSummary {
  readonly id: string;
  readonly path: string;
  readonly header: RecordingHeader;
  readonly sizeBytes: number;
}

export function encodeLine(value: RecordingHeader | RecordedEvent): string {
  return `${JSON.stringify(value)}\n`;
}
