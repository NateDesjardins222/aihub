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
  AdminInfra,
  AdminSystem,
  AdminTrading,
  AdminUser,
  AuditEntry,
  FundingQualification,
  FundingQualificationDetail,
  AdminExposure,
  PayoutListRow,
  PayoutCase,
  PayoutExposure,
  EconomicsRun,
  EconV2ConfigResponse,
  EconV2RunResponse,
  ProductConfig,
  TraderNote,
  EnfCase,
  EnfCaseDetail,
  EnfHold,
  EnfSignal,
  EnfFinding,
  EnfSummary,
} from './types';

const BASE = '/api/v1/admin';

export const adminApi = {
  overview: () => api.get<AdminOverview>(`${BASE}/overview`),

  users: (query: string, cursor?: string | null, filter?: string) => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (cursor) params.set('cursor', cursor);
    if (filter) params.set('filter', filter);
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

  infra: () => api.get<AdminInfra>(`${BASE}/infra`),

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

  // -- payouts --------------------------------------------------------------
  payoutQueue: (state?: string) =>
    api.get<{ rows: PayoutListRow[]; nextCursor: string | null }>(
      `${BASE}/payouts${state && state !== 'ALL' ? `?state=${encodeURIComponent(state)}` : ''}`,
    ),
  payoutCase: (id: string) => api.get<PayoutCase>(`${BASE}/payouts/${id}`),
  payoutExposure: () => api.get<PayoutExposure>(`${BASE}/payouts/exposure`),
  payoutAction: (id: string, action: string, body: Record<string, unknown>) =>
    api.post<{ id: string; state: string }>(`${BASE}/payouts/${id}/${action}`, body),

  // -- economics simulator (owner-only) -------------------------------------
  economicsScenarios: () => api.get<{ scenarios: string[]; base: unknown }>(`${BASE}/economics/scenarios`),
  economicsRun: (body: { scenario: string; seed: number; purchases: number; trials: number }) =>
    api.post<EconomicsRun>(`${BASE}/economics/run`, body),

  // Economics engine M13.0 (v2): full lifecycle + time/cash-flow.
  economicsV2Config: () => api.get<EconV2ConfigResponse>(`${BASE}/economics/v2/config`),
  economicsV2Run: (body: {
    scenario?: string; assumptions?: Record<string, unknown>; seed: number; customers: number; horizonDays: number; trials: number; persist?: boolean;
  }) => api.post<EconV2RunResponse>(`${BASE}/economics/v2/run`, body),
  economicsV2ExportUrl: (id: string, format: 'summary' | 'product' | 'timeline' | 'assumptions' | 'json') =>
    `${BASE}/economics/v2/run/${id}/export?format=${format}`,

  // Customer / Commerce console.
  customers: (q: string) =>
    api.get<{ customers: CustomerSearchRow[] }>(`${BASE}/customers?q=${encodeURIComponent(q)}&limit=50`),
  customer: (id: string) => api.get<CustomerDetail>(`${BASE}/customers/${id}`),
  customerExceptions: () => api.get<{ counts: Record<string, number> }>(`${BASE}/customers/exceptions`),
  customerReconciliation: () =>
    api.get<{ reconciliation: CustomerReconciliation }>(`${BASE}/customers/reconciliation`),
  customerQueue: (name: string) =>
    api.get<{ rows: Array<Record<string, unknown>> }>(`${BASE}/customers/queues/${name}`),
  customerRetryProvisioning: (orderId: string, reason: string) =>
    api.post<{ orderId: string; result: { status: string } }>(
      `${BASE}/customers/orders/${orderId}/retry-provisioning`,
      { reason },
    ),
  customerRequireReverification: (id: string, reason: string) =>
    api.post<{ ok: boolean }>(`${BASE}/customers/${id}/require-reverification`, { reason }),
  customerReviewDecision: (id: string, decision: 'IDENTITY_VERIFIED' | 'REJECTED', reason: string) =>
    api.post<{ ok: boolean }>(`${BASE}/customers/${id}/review-decision`, { decision, reason }),
  customerHold: (id: string, status: 'ACTIVE' | 'HOLD' | 'CLOSED', reason: string) =>
    api.post<{ ok: boolean }>(`${BASE}/customers/${id}/hold`, { status, reason }),
  customerResendNotification: (id: string, reason: string) =>
    api.post<{ requeued: boolean }>(`${BASE}/customers/notifications/${id}/resend`, { reason }),

  // -- enforcement (M7) -----------------------------------------------------
  // Everything is a server read; the console recommends nothing and decides
  // nothing. RBAC lives on the routes (SUPPORT reads; ADMIN acts; SUPER_ADMIN
  // confirms serious violations / terminates / overrides appeal independence).
  enfSummary: () => api.get<EnfSummary>(`${BASE}/enforcement/summary`),
  enfCases: (q: { status?: string; severity?: string; category?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    return api.get<{ cases: EnfCase[] }>(`${BASE}/enforcement/cases?${params.toString()}`);
  },
  enfCase: (id: string) => api.get<EnfCaseDetail>(`${BASE}/enforcement/cases/${id}`),
  enfSignals: () => api.get<{ signals: EnfSignal[] }>(`${BASE}/enforcement/signals`),
  enfHolds: (q: { status?: string; capability?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
    return api.get<{ holds: EnfHold[] }>(`${BASE}/enforcement/holds?${params.toString()}`);
  },
  enfOpenCase: (body: { customerIdentityId: string; category: string; accountId?: string; reasonCode?: string; severity?: string }) =>
    api.post<{ case: EnfCase }>(`${BASE}/enforcement/cases`, body),
  enfAssign: (id: string, assigneeUserId: string | null) =>
    api.post<{ case: EnfCase }>(`${BASE}/enforcement/cases/${id}/assign`, { assigneeUserId }),
  enfTransition: (id: string, to: string, reason?: string, expectedVersion?: number) =>
    api.post<{ case: EnfCase }>(`${BASE}/enforcement/cases/${id}/transition`, { to, reason, expectedVersion }),
  enfNote: (id: string, body: string, visibility?: string) =>
    api.post<{ ok: boolean }>(`${BASE}/enforcement/cases/${id}/note`, { body, visibility }),
  enfEvidence: (id: string, body: { type: string; source: string; sourceRef?: string; visibility?: string }) =>
    api.post<{ evidenceId: string }>(`${BASE}/enforcement/cases/${id}/evidence`, body),
  enfPlaceHold: (id: string, body: { scope: string; scopeId: string; capability: string; reasonCode: string; customerSafeCategory?: string; expiresAt?: string }) =>
    api.post<{ hold: EnfHold }>(`${BASE}/enforcement/cases/${id}/holds`, body),
  enfReleaseHold: (holdId: string, reason?: string) =>
    api.post<{ hold: EnfHold }>(`${BASE}/enforcement/holds/${holdId}/release`, { reason }),
  enfFinding: (id: string, body: { reasonCode: string; summarySafe?: string; rationaleInternal?: string; appealable?: boolean }) =>
    api.post<{ finding: EnfFinding }>(`${BASE}/enforcement/cases/${id}/finding`, body),
  enfAction: (id: string, body: { actionType: string; reasonCode?: string }) =>
    api.post<{ actionId: string; deduped: boolean }>(`${BASE}/enforcement/cases/${id}/action`, body),
  enfInfoRequest: (id: string, body: { requestType: string; messageSafe: string; dueAt?: string }) =>
    api.post<{ requestId: string }>(`${BASE}/enforcement/cases/${id}/info-request`, body),
  enfDecideAppeal: (appealId: string, body: { decision: string; rationaleInternal?: string; customerSafeExplanation?: string; overrideSameReviewer?: boolean }) =>
    api.post<{ ok: boolean }>(`${BASE}/enforcement/appeals/${appealId}/decide`, body),

  // -- payout operations (M8) -----------------------------------------------
  poOverview: () => api.get<PoOverview>(`${BASE}/payout-ops/overview`),
  poOperations: (state?: string) =>
    api.get<{ operations: PoOperation[] }>(`${BASE}/payout-ops/operations${state ? `?state=${encodeURIComponent(state)}` : ''}`),
  poOperation: (id: string) => api.get<PoOperationDetail>(`${BASE}/payout-ops/operations/${id}`),
  poConfig: () => api.get<{ config: PoConfig; providerHealth: { id: string; isMock: boolean; configured: boolean; state: string } }>(`${BASE}/payout-ops/config`),
  poUpdateConfig: (body: Partial<PoConfig> & { expectedVersion?: number }) =>
    api.patch<{ config: PoConfig }>(`${BASE}/payout-ops/config`, body),
  poCircuitBreaker: (action: 'OPEN' | 'CLOSE', reason: string) =>
    api.post<{ ok: boolean; open: boolean }>(`${BASE}/payout-ops/circuit-breaker`, { action, reason }),
  poRetry: (id: string) => api.post<{ opState: string }>(`${BASE}/payout-ops/operations/${id}/retry`, {}),
  poReconcile: (id: string) => api.post<{ mismatchType: string; autoResolved: boolean }>(`${BASE}/payout-ops/operations/${id}/reconcile`, {}),
  poManualResolution: (id: string, body: { resolution: 'MARK_PAID' | 'ACKNOWLEDGE_RETURN'; reason: string; externalReference: string; amountMicros: number }) =>
    api.post<{ opState: string }>(`${BASE}/payout-ops/operations/${id}/manual-resolution`, body),
};

export interface PoOverview {
  requestedToday: number; submittedToday: number; paidToday: number;
  dollarsRequestedMicros: number; dollarsSubmittedMicros: number; dollarsPaidMicros: number;
  fastLaneRate: number; exceptionRate: number; providerFailureRate: number; reconciliationMismatchRate: number;
  medianRequestToSubmissionMs: number | null; p90RequestToSubmissionMs: number | null;
  p95RequestToSubmissionMs: number | null; p99RequestToSubmissionMs: number | null;
  overFiveMinuteCount: number; exceptionCount: number; failedCount: number; returnedCount: number; reconciliationMismatchCount: number;
  provider: { id: string; configured: boolean; state: string }; circuitBreakerOpen: boolean;
}
export interface PoOperation {
  payoutRequestId: string; accountId: string; accountPublicId: string | null; traderEmail: string | null;
  opState: string; exceptionCategory: string | null; customerSafeCategory: string | null; fastLane: boolean;
  provider: string | null; providerPayoutId: string | null; requestedGrossMicros: number; traderShareMicros: number | null;
  slaBreached: boolean; requestedAt: string; submittedAt: string | null; paidAt: string | null; requestToSubmissionMs: number | null;
}
export interface PoConfig {
  productionEnabled: boolean; provider: string | null; reserveThresholdMicros: number;
  maxSingleAutoMicros: number | null; maxAggregateAutoPerDayMicros: number | null;
  circuitBreakerOpen: boolean; reconStaleThresholdSeconds: number; version: number;
}
export interface PoOperationDetail {
  operation: Record<string, unknown> & { opState: string; exceptionCategory: string | null; fastLane: boolean; providerPayoutId: string | null; slaBreached: boolean };
  request: Record<string, unknown> | null;
  checks: Array<{ id: string; checkType: string; result: string; category: string | null; detailSafe: string | null; createdAt: string }>;
  attempts: Array<{ id: string; attemptNumber: number; provider: string; normalizedResult: string | null; errorCategory: string | null; retryable: boolean; providerPayoutId: string | null; startedAt: string; completedAt: string | null }>;
  providerEvents: Array<{ id: string; providerEventId: string; normalizedType: string; processingState: string; receivedAt: string }>;
  reconciliation: Array<{ id: string; mismatchType: string; resolution: string; autoResolved: boolean; createdAt: string }>;
  timings: { requestToApprovalMs: number | null; requestToSubmissionMs: number | null; submissionToAckMs: number | null; submissionToPaidMs: number | null };
  timeline: Array<{ at: string; label: string }>;
}

export interface CustomerSearchRow {
  customerIdentityId: string;
  userId: string;
  email: string;
  displayName: string;
  identityStatus: string;
  status: string;
  createdAt: string;
}

export interface CustomerReconciliation {
  paymentEventsReceived: number;
  paymentEventsProcessed: number;
  orders: { provisioned: number; completed: number; blocked: number; failed: number; refunded: number };
  entitlements: number;
  accounts: { evaluation: number; funded: number };
  discrepancies: { unprocessedCommerceEvents: number; provisioningExceptions: number; unreconciledPayments: number };
  balanced: boolean;
}

export interface CustomerDetail {
  identity: { id: string; identityStatus: string; status: string; legalName: string | null; country: string | null };
  user: { id: string; email: string; displayName: string; role: string } | null;
  contacts: Array<{ id: string; channel: string; value: string; status: string; isPrimary: boolean }>;
  verifications: Array<{ id: string; provider: string; status: string; reasonCode: string | null; createdAt: string }>;
  acceptances: Array<{ id: string; agreementType: string; contentHash: string; acceptedAt: string }>;
  outstandingAgreements: Array<{ agreementType: string; versionId: string; version: number }>;
  orders: Array<{ id: string; status: string; source: string; amountMicros: number | null; provisionNote: string | null; createdAt: string }>;
  entitlements: Array<{ id: string; kind: string; status: string; consumedByAccountId: string | null }>;
  accounts: Array<{ id: string; publicId: string; name: string; accountType: string; status: string; adminHold: string | null; balanceMicros: number }>;
  copyGroups: Array<{
    group: {
      id: string; name: string; status: string; sizingMode: string;
      leader: { accountId: string; publicId: string; name: string; status: string; eligible: boolean } | null;
      followers: Array<{ accountId: string; publicId: string; name: string; status: string; enabled: boolean; eligible: boolean; sizingMultiplierMilli: number | null; sizingFixedQty: number | null }>;
    };
    sync: { status: string; divergedAccountIds: string[] } | null;
    recentIntents: Array<{ intentId: string; kind: string; accepted: number; rejected: number; skipped: number; total: number; rejections: Array<{ accountId: string; publicId: string; code: string | null }> }>;
  }>;
  supportTickets: Array<{ id: string; publicRef: string; subject: string; categoryKey: string; status: string; priority: string; createdAt: string; updatedAt: string; resolvedAt: string | null; csatRating: number | null }>;
  notifications: Array<{ id: string; type: string; channel: string; status: string; provider: string | null; createdAt: string }>;
  audit: Array<{ id: string; action: string; subjectType: string; createdAt: string; reason: string | null }>;
  providers: { identity: string; commerce: string; email: string; sms: string };
}
