/**
 * Copy-trading REST client — thin wrapper over /api/v1/copy/*. The server is
 * authoritative for everything; this only shuttles requests.
 */
import { api } from '../api/client';

export type SizingMode = 'SAME' | 'MULTIPLIER' | 'FIXED';

export interface EligibleAccount {
  id: string; publicId: string; name: string; nickname: string | null;
  accountType: string; status: string; eligible: boolean; reason: string | null;
}
export interface GroupFollowerView {
  accountId: string; publicId: string; name: string; nickname: string | null;
  accountType: string; status: string; enabled: boolean; eligible: boolean; reason: string | null;
  sizingMultiplierMilli: number | null; sizingFixedQty: number | null;
}
export interface GroupView {
  id: string; name: string; status: string; sizingMode: SizingMode; version: number;
  leader: { accountId: string; publicId: string; name: string; nickname: string | null; accountType: string; status: string; eligible: boolean } | null;
  followers: GroupFollowerView[]; createdAt: number; updatedAt: number;
}
export interface CopyChildResult {
  accountId: string; publicId: string; role: 'LEADER' | 'FOLLOWER';
  status: 'ACCEPTED' | 'REJECTED' | 'SKIPPED' | 'PENDING';
  requestedQty: number; sizingNote: string | null; orderId: string | null;
  rejectCode: string | null; rejectMessage: string | null;
}
export interface CopyIntentResult {
  intentId: string; kind: string; reused: boolean;
  accepted: number; rejected: number; skipped: number; total: number; children: CopyChildResult[];
}
export interface FollowerDelta {
  accountId: string; publicId: string; symbol: string;
  expectedQty: number; actualQty: number; deltaQty: number; side: 'BUY' | 'SELL' | null; inSync: boolean;
}
export interface GroupSyncView { groupId: string; status: string; followers: FollowerDelta[]; divergedAccountIds: string[] }

export type BracketUnit = 'TICKS' | 'POINTS' | 'DOLLARS';
export type CopyBracketOffset = { unit: BracketUnit; value: number } | null;

export interface CopyOrder {
  symbol: string; side: 'BUY' | 'SELL'; qty: number;
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT' | 'TRAILING_STOP';
  limitPrice?: number | null; stopPrice?: number | null;
  tif?: 'DAY' | 'GTC' | 'IOC' | 'FOK';
  trailTicks?: number | null;
  bracket?: { stopLoss?: CopyBracketOffset; takeProfit?: CopyBracketOffset; trailingStop?: CopyBracketOffset } | null;
}

export const copyApi = {
  eligibleAccounts: () => api.get<{ accounts: EligibleAccount[] }>('/api/v1/copy/eligible-accounts'),
  groups: () => api.get<{ groups: GroupView[] }>('/api/v1/copy/groups'),
  group: (id: string) => api.get<GroupView>(`/api/v1/copy/groups/${id}`),
  createGroup: (body: { name: string; leaderAccountId: string; sizingMode: SizingMode }) => api.post<GroupView>('/api/v1/copy/groups', body),
  updateGroup: (id: string, body: { name?: string; sizingMode?: SizingMode }) => api.patch<GroupView>(`/api/v1/copy/groups/${id}`, body),
  setLeader: (id: string, leaderAccountId: string) => api.post<GroupView>(`/api/v1/copy/groups/${id}/leader`, { leaderAccountId }),
  addFollower: (id: string, body: { accountId: string; sizingMultiplierMilli?: number | null; sizingFixedQty?: number | null }) => api.post<GroupView>(`/api/v1/copy/groups/${id}/followers`, body),
  updateFollower: (id: string, accountId: string, body: { enabled?: boolean; sizingMultiplierMilli?: number | null; sizingFixedQty?: number | null }) => api.patch<GroupView>(`/api/v1/copy/groups/${id}/followers/${accountId}`, body),
  removeFollower: (id: string, accountId: string) => api.delete<GroupView>(`/api/v1/copy/groups/${id}/followers/${accountId}`),
  pause: (id: string) => api.post<GroupView>(`/api/v1/copy/groups/${id}/pause`, {}),
  resume: (id: string) => api.post<GroupView>(`/api/v1/copy/groups/${id}/resume`, {}),
  disable: (id: string) => api.post<GroupView>(`/api/v1/copy/groups/${id}/disable`, {}),
  sync: (id: string) => api.get<GroupSyncView>(`/api/v1/copy/groups/${id}/sync`),
  resync: (id: string, idempotencyKey: string) => api.post<{ results: CopyIntentResult[] }>(`/api/v1/copy/groups/${id}/resync`, { idempotencyKey }),
  flatten: (id: string, idempotencyKey: string, symbol?: string | null) => api.post<CopyIntentResult>(`/api/v1/copy/groups/${id}/flatten`, { idempotencyKey, symbol: symbol ?? null }),
  submitIntent: (id: string, idempotencyKey: string, order: CopyOrder) => api.post<CopyIntentResult>(`/api/v1/copy/groups/${id}/intents`, { idempotencyKey, order }),
  intents: (id: string) => api.get<{ intents: CopyIntentResult[] }>(`/api/v1/copy/groups/${id}/intents`),
};
