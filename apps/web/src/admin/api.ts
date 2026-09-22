/**
 * The admin client.
 *
 * A thin wrapper over the same REST client the terminal uses, so tokens,
 * refresh and error shapes behave identically. Nothing here computes anything:
 * every number on screen came from the server.
 */
import { api } from '../api/client';
import type {
  AdminAccount,
  AdminAccountDetail,
  AdminLiveView,
  AdminOverview,
  AdminProductDetail,
  AdminProductDraft,
  AdminProfile,
  AdminRisk,
  AdminSystem,
  AdminTrading,
  AdminUser,
  AuditEntry,
  FundingQualification,
  FundingQualificationDetail,
  AdminExposure,
  ProductConfig,
  TraderNote,
} from './types';

const BASE = '/api/v1/admin';

export const adminApi = {
  overview: () => api.get<AdminOverview>(`${BASE}/overview`),

  users: (query: string, cursor?: string | null) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (cursor) params.set('cursor', cursor);
    params.set('limit', '50');
    return api.get<{ users: AdminUser[]; nextCursor: string | null }>(
      `${BASE}/users?${params.toString()}`,
    );
  },

  user: (id: string) =>
    api.get<{
      user: AdminUser;
      accounts: AdminAccount[];
      activity: AuditEntry[];
      trades: Array<{
        accountPublicId: string;
        symbol: string;
        side: string;
        qty: number;
        netPnlMicros: number;
        exitTime: number;
        tradeDate: string;
      }>;
    }>(`${BASE}/users/${id}`),

  accounts: (query: string, status: string, cursor?: string | null) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    params.set('limit', '100');
    return api.get<{ accounts: AdminAccount[]; nextCursor: string | null }>(
      `${BASE}/accounts?${params.toString()}`,
    );
  },

  account: (id: string) => api.get<AdminAccountDetail>(`${BASE}/accounts/${id}`),

  live: (id: string) => api.get<AdminLiveView>(`${BASE}/accounts/${id}/live`),

  profiles: () => api.get<{ profiles: AdminProfile[] }>(`${BASE}/profiles`),

  product: (key: string) => api.get<AdminProductDetail>(`${BASE}/profiles/${encodeURIComponent(key)}`),

  saveDraft: (
    key: string,
    body: {
      name: string;
      accountType: string;
      description?: string | null;
      notes?: string | null;
      config: ProductConfig;
    },
  ) => api.put<{ draft: AdminProductDraft }>(`${BASE}/profiles/${encodeURIComponent(key)}/draft`, body),

  discardDraft: (key: string) =>
    api.delete<{ discarded: boolean }>(`${BASE}/profiles/${encodeURIComponent(key)}/draft`),

  publishDraft: (key: string) =>
    api.post<{ profileId: string; key: string; version: number }>(
      `${BASE}/profiles/${encodeURIComponent(key)}/publish`,
      {},
    ),

  setProductStatus: (key: string, status: 'ACTIVE' | 'RETIRED', reason: string) =>
    api.patch<{ profileId: string; key: string; status: string }>(
      `${BASE}/profiles/${encodeURIComponent(key)}/status`,
      { status, reason },
    ),

  auditExplorer: (params: {
    action?: string;
    actor?: string;
    subjectType?: string;
    from?: number;
    to?: number;
    cursor?: string | null;
  }) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) search.set(k, String(v));
    return api.get<{ entries: AuditEntry[]; nextCursor: string | null }>(
      `${BASE}/audit?${search.toString()}`,
    );
  },

  audit: (params: { accountId?: string; userId?: string; action?: string }) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
    return api.get<{ entries: AuditEntry[] }>(`${BASE}/audit?${search.toString()}`);
  },

  verifyAudit: () =>
    api.get<{ ok: boolean; checked: number; brokenAt: string | null }>(`${BASE}/audit/verify`),

  provision: (body: {
    userId: string;
    profileKey: string;
    displayName?: string;
    startingBalanceMicros?: number;
    activate?: boolean;
  }) =>
    api.post<{ accountId: string; publicId: string; reused: boolean }>(`${BASE}/accounts`, body),

  /** Every account action takes a confirmation and a reason. Both are audited. */
  action: (accountId: string, action: string, reason: string) =>
    api.post<{ ok: boolean; result: unknown }>(`${BASE}/accounts/${accountId}/${action}`, {
      confirm: true,
      reason,
    }),

  userAction: (userId: string, action: 'disable' | 'enable', reason: string) =>
    api.post<{ user: AdminUser }>(`${BASE}/users/${userId}/${action}`, { confirm: true, reason }),

  // Internal staff notes (Owner Control Center V3). A trader never sees these.
  traderNotes: (userId: string) =>
    api.get<{ notes: TraderNote[] }>(`${BASE}/users/${userId}/notes`),
  createTraderNote: (userId: string, category: string, body: string) =>
    api.post<{ note: TraderNote }>(`${BASE}/users/${userId}/notes`, { category, body }),
  redactTraderNote: (userId: string, noteId: string) =>
    api.post<{ note: TraderNote }>(`${BASE}/users/${userId}/notes/${noteId}/redact`, {}),

  trading: () => api.get<AdminTrading>(`${BASE}/trading`),

  exposure: () => api.get<AdminExposure>(`${BASE}/exposure`),

  risk: () => api.get<AdminRisk>(`${BASE}/risk`),

  system: () => api.get<AdminSystem>(`${BASE}/system`),

  // Commercial account lifecycle: the passed queue and the funding decision.
  fundingQueue: (state: string) =>
    api.get<{ state: string; qualifications: FundingQualification[] }>(
      `${BASE}/funding-queue?state=${encodeURIComponent(state)}`,
    ),

  qualification: (id: string) =>
    api.get<FundingQualificationDetail>(`${BASE}/qualifications/${id}`),

  approveFunding: (id: string) =>
    api.post<{ fundedAccountId: string; reused: boolean }>(
      `${BASE}/qualifications/${id}/approve-funding`,
      {},
    ),

  declineFunding: (id: string, reason: string) =>
    api.post<{ id: string; fundingState: string }>(
      `${BASE}/qualifications/${id}/decline-funding`,
      { reason },
    ),

  grantEvaluation: (body: { userId?: string; email?: string; profileKey: string }) =>
    api.post<{ accountId: string; orderId: string; entitlementId: string }>(`${BASE}/grants`, body),
};
