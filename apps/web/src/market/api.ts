/** Market-data REST calls. */
import { api } from '../api/client';
import type { NormalizedBar, Timeframe } from '@atlas/contracts';

export interface BarsResponse {
  symbol: string;
  timeframe: Timeframe;
  bars: NormalizedBar[];
  hasMore: boolean;
  nextCursor: number | null;
  limitReason: string | null;
  source: 'CACHE' | 'PROVIDER' | 'MIXED';
  /** How many bars in this page broke an invariant. Should always be zero. */
  integrity: { violations: number; first: string | null };
  provider: string;
  mode: 'DELAYED' | 'REALTIME' | 'REPLAY';
  pricePrecision: number;
  barCloseInSeconds: number | null;
}

export interface FreshnessInfo {
  symbol: string;
  state: 'FRESH' | 'STALE' | 'MARKET_CLOSED' | 'NO_DATA';
  ageMs: number | null;
  excessMs: number | null;
  thresholdMs: number;
  lastExchangeTs: number | null;
  blocksOrderEntry: boolean;
}

export interface SymbolStatusResponse {
  symbol: string;
  quote: {
    symbol: string;
    exchangeTs: number;
    bid: number | null;
    ask: number | null;
    last: number | null;
    seq: number;
  } | null;
  freshness: FreshnessInfo;
  marketState: { state: string; reason: string | null; tradingDate: string };
}

export interface MarketStatusResponse {
  connection: {
    providerId: string;
    state: string;
    mode: 'DELAYED' | 'REALTIME' | 'REPLAY';
    delaySeconds: number;
    lastEventAt: number | null;
    reconnectAttempts: number;
    error?: string;
  };
  capabilities: {
    providesTrades: boolean;
    providesQuotes: boolean;
    providesTopOfBook: boolean;
    providesDepth: boolean;
    providesOhlcv: boolean;
    notes: string[];
  } | null;
  depthLevels: number;
  depthAvailable: boolean;
  symbols: SymbolStatusResponse[];
  replay: ReplayState;
  serverTime: number;
}

export interface ReplayState {
  loaded: boolean;
  recordingId: string | null;
  symbol: string | null;
  playing: boolean;
  speed: number;
  cursor: number;
  total: number;
  clock: number | null;
  startTs: number | null;
  endTs: number | null;
  progress: number;
  header: { tradingDate: string; captureMethod: string; eventCount: number; notes: string } | null;
  /** A random session keeps its identity to itself until it ends. */
  blind: boolean;
  /** How far into the recording the replay has run. Safe to show when blind. */
  elapsedMs: number | null;
}

export interface RecordingSummary {
  id: string;
  path: string;
  sizeBytes: number;
  header: {
    symbol: string;
    tradingDate: string;
    captureMethod: string;
    eventCount: number;
    startTs: number;
    endTs: number;
    baseTimeframe: string;
    notes: string;
  };
}

export function fetchBars(
  symbol: string,
  timeframe: Timeframe,
  opts: { limit?: number; before?: number } = {},
): Promise<BarsResponse> {
  const params = new URLSearchParams({ symbol, timeframe });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', String(opts.before));
  return api.get<BarsResponse>(`/api/v1/marketdata/bars?${params.toString()}`);
}

export function fetchSymbolStatus(symbol: string): Promise<SymbolStatusResponse> {
  return api.get<SymbolStatusResponse>(
    `/api/v1/marketdata/quote?symbol=${encodeURIComponent(symbol)}`,
  );
}

export function fetchMarketStatus(): Promise<MarketStatusResponse> {
  return api.get<MarketStatusResponse>('/api/v1/marketdata/status');
}

export function fetchRecordings(): Promise<{ recordings: RecordingSummary[] }> {
  return api.get('/api/v1/marketdata/recordings');
}

export function captureSession(
  symbol: string,
  date: string,
  timeframe: Timeframe = '1m',
): Promise<RecordingSummary> {
  return api.post('/api/v1/marketdata/recordings/capture', { symbol, date, timeframe });
}

export const replayApi = {
  state: () => api.get<ReplayState>('/api/v1/marketdata/replay'),
  load: (recordingId: string) =>
    api.post<ReplayState>('/api/v1/marketdata/replay/load', { recordingId }),
  play: () => api.post<ReplayState>('/api/v1/marketdata/replay/play'),
  pause: () => api.post<ReplayState>('/api/v1/marketdata/replay/pause'),
  reset: () => api.post<ReplayState>('/api/v1/marketdata/replay/reset'),
  speed: (speed: number) => api.post<ReplayState>('/api/v1/marketdata/replay/speed', { speed }),
  seek: (progress: number) => api.post<ReplayState>('/api/v1/marketdata/replay/seek', { progress }),
  step: (count = 1) => api.post<ReplayState>('/api/v1/marketdata/replay/step', { count }),
  restart: () => api.post<ReplayState>('/api/v1/marketdata/replay/restart', {}),
  skip: (accountId: string, minutes?: number, toTs?: number) =>
    api.post<ReplayState>('/api/v1/marketdata/replay/skip', { accountId, minutes, toTs }),
  seekTime: (ts: number) => api.post<ReplayState>('/api/v1/marketdata/replay/seek-time', { ts }),
  anchors: () =>
    api.get<{
      anchors: Array<{
        id: string;
        label: string;
        description: string;
        at: number | null;
        offsetMs: number;
      }>;
    }>('/api/v1/marketdata/replay/anchors'),
  random: (symbol?: string, blind = true) =>
    api.post<ReplayState>('/api/v1/marketdata/replay/random', { symbol, blind }),
  availableSessions: (symbol: string, days = 10) =>
    api.get<{
      symbol: string;
      recordings: Array<{
        id: string;
        symbol: string;
        tradingDate: string;
        events: number;
        captureMethod: string;
        startTs: number;
        endTs: number;
      }>;
      dates: Array<{ date: string; captured: boolean; weekday: number }>;
      historyNote: string;
    }>(`/api/v1/marketdata/sessions?symbol=${symbol}&days=${days}`),
  useProvider: (provider: 'live' | 'replay') =>
    api.post<{ provider: string; mode: string }>('/api/v1/marketdata/provider', { provider }),
};
