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
  AdminProfile,
  AdminUser,
  AuditEntry,
} from './types';

const BASE = '/api/v1/admin';

export const adminApi = {
  overview: () => api.get<AdminOverview>(`${BASE}/overview`),

  users: (query: string) =>
    api.get<{ users: AdminUser[] }>(
      `${BASE}/users${query ? `?q=${encodeURIComponent(query)}` : ''}`,
    ),

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

  accounts: (query: string, status: string) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    params.set('limit', '100');
    return api.get<{ accounts: AdminAccount[] }>(`${BASE}/accounts?${params.toString()}`);
  },

  account: (id: string) => api.get<AdminAccountDetail>(`${BASE}/accounts/${id}`),

  live: (id: string) => api.get<AdminLiveView>(`${BASE}/accounts/${id}/live`),

  profiles: () => api.get<{ profiles: AdminProfile[] }>(`${BASE}/profiles`),

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
};
