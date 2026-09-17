/**
 * Journal, practice-session and analytics client.
 *
 * Read-and-annotate only: nothing here can change a position, an order or a
 * balance. The figures are the server's; the words are the trader's.
 */
import { api } from '../api/client';

export interface ApiJournalTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  holdMs: number;
  grossPnlMicros: number;
  feesMicros: number;
  netPnlMicros: number;
  maeMicros: number;
  mfeMicros: number;
  initialRiskMicros: number | null;
  rMultiple: number | null;
  tradeDate: string;
  sessionId: string | null;
  notes: string | null;
  tagIds: string[];
}

export interface ApiTag {
  id: string;
  name: string;
  color: string;
  kind: 'GOOD' | 'BAD' | 'NEUTRAL';
  sort: number;
}

export interface ApiBucket {
  key: string;
  label: string;
  trades: number;
  netPnlMicros: number;
  winRate: number | null;
  expectancyMicros: number | null;
}

export interface ApiStats {
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number | null;
  grossProfitMicros: number;
  grossLossMicros: number;
  netPnlMicros: number;
  feesMicros: number;
  profitFactor: number | null;
  expectancyMicros: number | null;
  expectancyR: number | null;
  avgWinMicros: number | null;
  avgLossMicros: number | null;
  largestWinMicros: number | null;
  largestLossMicros: number | null;
  avgHoldMs: number | null;
  avgWinHoldMs: number | null;
  avgLossHoldMs: number | null;
  avgMaeMicros: number | null;
  avgMfeMicros: number | null;
  captureRatio: number | null;
  streaks: { longestWins: number; longestLosses: number; currentWins: number; currentLosses: number };
  contracts: number;
  ratedTrades: number;
  avgRMultiple: number | null;
  totalR: number | null;
}

export interface ApiAnalytics {
  accountId: string;
  startingBalanceMicros: number;
  stats: ApiStats;
  curve: {
    points: Array<{ at: number; tradeId: string; equityMicros: number; drawdownMicros: number }>;
    startMicros: number;
    endMicros: number;
    peakMicros: number;
    maxDrawdownMicros: number;
    maxDrawdownPct: number | null;
  };
  breakdowns: {
    bySymbol: ApiBucket[];
    bySide: ApiBucket[];
    byHour: ApiBucket[];
    byWeekday: ApiBucket[];
    byDate: ApiBucket[];
  };
  days: Array<{ tradeDate: string; netPnlMicros: number; trades: number; wins: number; losses: number }>;
}

export interface ApiPracticeSession {
  id: string;
  accountId: string;
  source: 'LIVE' | 'REPLAY';
  mode: string;
  config: Record<string, unknown> | null;
  recordingId: string | null;
  symbol: string | null;
  tradingDate: string | null;
  dateHidden: boolean;
  startingBalanceMicros: number;
  endingBalanceMicros: number | null;
  startedAt: number;
  endedAt: number | null;
  summary: Record<string, unknown> | null;
  notes: string | null;
}

export interface ApiSessionReview {
  version: number;
  sessionId: string;
  mode: string;
  symbol: string | null;
  tradingDate: string | null;
  startedAt: number;
  endedAt: number | null;
  startingBalanceMicros: number;
  endingBalanceMicros: number | null;
  netPnlMicros: number;
  stats: ApiStats;
  curve: ApiAnalytics['curve'];
  breakdowns: ApiAnalytics['breakdowns'];
  bestTrade: ApiJournalTrade | null;
  worstTrade: ApiJournalTrade | null;
  violations: Array<{ rule: string; reasonCode: string; detail: unknown; at: number }>;
  programme: {
    status: string;
    canTrade: boolean;
    profitProgressMicros: number;
    profitTargetMicros: number;
    remainingDrawdownMicros: number;
    requirements: Array<{ key: string; label: string; met: boolean; current: number; required: number; unit: string }>;
    breach: { code: string; message: string } | null;
  } | null;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

export const journalApi = {
  trades: (accountId: string, filters: Record<string, string | number | undefined> = {}) =>
    api.get<{ trades: ApiJournalTrade[] }>(`/api/v1/journal/trades?${qs({ accountId, ...filters })}`),
  analytics: (accountId: string, filters: Record<string, string | number | undefined> = {}) =>
    api.get<ApiAnalytics>(`/api/v1/journal/analytics?${qs({ accountId, ...filters })}`),
  setNotes: (tradeId: string, notes: string | null) =>
    api.patch<{ trade: ApiJournalTrade }>(`/api/v1/journal/trades/${tradeId}`, { notes }),
  setTradeTags: (tradeId: string, tagIds: string[]) =>
    api.put<{ tradeId: string; tagIds: string[] }>(`/api/v1/journal/trades/${tradeId}/tags`, {
      tagIds,
    }),

  tags: () => api.get<{ tags: ApiTag[] }>('/api/v1/journal/tags'),
  createTag: (tag: { name: string; color?: string; kind?: 'GOOD' | 'BAD' | 'NEUTRAL'; sort?: number }) =>
    api.post<{ tag: ApiTag }>('/api/v1/journal/tags', tag),
  updateTag: (id: string, patch: Partial<Omit<ApiTag, 'id'>>) =>
    api.patch<{ tag: ApiTag }>(`/api/v1/journal/tags/${id}`, patch),
  deleteTag: (id: string) => api.delete<{ deleted: string }>(`/api/v1/journal/tags/${id}`),

  sessions: (accountId: string, limit = 50) =>
    api.get<{ sessions: ApiPracticeSession[] }>(
      `/api/v1/journal/sessions?${qs({ accountId, limit })}`,
    ),
  activeSession: (accountId: string) =>
    api.get<{ session: ApiPracticeSession | null }>(
      `/api/v1/journal/sessions/active?${qs({ accountId })}`,
    ),
  session: (id: string) =>
    api.get<{
      session: ApiPracticeSession;
      review: ApiSessionReview;
      tagIds: string[];
      trades: ApiJournalTrade[];
    }>(`/api/v1/journal/sessions/${id}`),
  startSession: (body: {
    accountId: string;
    source?: 'LIVE' | 'REPLAY';
    mode?: string;
    config?: Record<string, unknown>;
    recordingId?: string | null;
    symbol?: string | null;
    tradingDate?: string | null;
    dateHidden?: boolean;
  }) => api.post<{ session: ApiPracticeSession }>('/api/v1/journal/sessions', body),
  endSession: (id: string) =>
    api.post<{ session: ApiPracticeSession }>(`/api/v1/journal/sessions/${id}/end`, {}),
  annotateSession: (id: string, patch: { notes?: string | null; tagIds?: string[] }) =>
    api.patch<{ session: ApiPracticeSession }>(`/api/v1/journal/sessions/${id}`, patch),
};

/** Preferences: display choices that survive a reload. Never trading state. */
/**
 * Drawings, stored on their own.
 *
 * Kept apart from the preferences because they are the one part of a
 * workspace with no natural size: a marked-up chart is hundreds of objects,
 * and a save that fails has to fail visibly rather than take the rest of the
 * workspace down with it.
 */
export const drawingsApi = {
  read: () => api.get<{ drawings: unknown[] | null }>('/api/v1/drawings'),
  write: (drawings: readonly unknown[]) =>
    api.put<{ drawings: unknown[] }>('/api/v1/drawings', { drawings }),
};

export const preferencesApi = {
  read: () => api.get<{ preferences: Record<string, unknown> }>('/api/v1/preferences'),
  write: (preferences: Record<string, unknown>) =>
    api.put<{ preferences: Record<string, unknown> }>('/api/v1/preferences', preferences),
};
