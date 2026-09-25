/**
 * Affiliate web client.
 *
 * Public endpoints use a plain fetch (no auth); portal endpoints go through the
 * shared authenticated REST client so tokens/refresh behave identically. Nothing
 * here computes money — every figure is server-authoritative.
 */
import { api } from '../api/client';

const AFF = '/api/v1/affiliates';

// ---- shared shapes ---------------------------------------------------------
export interface ProgramInfo {
  applicationsEnabled: boolean;
  baseRateBps: number;
  tiers: Array<{ tier: string; rateBps: number; thresholdMicros: number }>;
  attributionWindowDays: number;
  commissionMaturityDays: number;
  minPayoutMicros: number;
}
export interface AgreementDoc { version: number; title: string; body: string; contentHash?: string }

export interface AffiliateBalance {
  availableMicros: number; pendingMicros: number; inFlightPayoutMicros: number;
  withdrawableMicros: number; lifetimePaidMicros: number; reversalMicros: number;
}
export interface TierProgress {
  tier: string; effectiveRateBps: number; monthlyQualifiedMicros: number;
  nextTier: string | null; nextThresholdMicros: number | null; remainingMicros: number | null;
}
export interface DashboardCode { code: string; kind: string; status: string; discountBps: number | null; campaignLabel: string | null }
export interface Dashboard {
  enrolled: true;
  affiliate: { id: string; publicId: string; displayName: string; status: string; tier: string; effectiveRateBps: number };
  tierProgress: TierProgress;
  balance: AffiliateBalance;
  last30: { clicks: number; uniqueSessions: number; conversions: number; referredRevenueMicros: number; conversionRate: number };
  codes: DashboardCode[];
}
export interface Onboarding { enrolled: true; onboarding: true; status: string; publicId: string }
export interface NotEnrolled { enrolled: false }
export type MeResponse = Dashboard | Onboarding | NotEnrolled;

export interface ConversionRow {
  id: string; createdAt: string; customer: string; qualifiedRevenueMicros: number;
  source: string; rateBps: number | null; commissionMicros: number | null; status: string | null;
}
export interface PayoutRow {
  id: string; status: string; amountMicros: number; method: string | null;
  externalReference: string | null; createdAt: string; paidAt: string | null;
}
export interface ProviderStatus { configured: boolean; verified: boolean; provider: string | null; note: string }

// ---- public (no auth) ------------------------------------------------------
async function pub<T>(path: string): Promise<T> {
  const r = await fetch(`${AFF}${path}`);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return (await r.json()) as T;
}

export const affiliatePublic = {
  program: () => pub<ProgramInfo>('/program'),
  agreement: () => pub<AgreementDoc>('/agreement'),
  apply: async (body: Record<string, unknown>): Promise<{ ok: boolean; affiliateId: string } | { error: string }> => {
    const r = await fetch(`${AFF}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { error: (data as { error?: { message?: string } })?.error?.message ?? `Application failed (${r.status})` };
    return data as { ok: boolean; affiliateId: string };
  },
  click: async (body: { code: string; sessionRef: string; landingPath?: string }): Promise<void> => {
    await fetch(`${AFF}/click`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => undefined);
  },
};

// ---- portal (auth) ---------------------------------------------------------
export const affiliatePortal = {
  me: () => api.get<MeResponse>(`${AFF}/me`),
  agreement: () => api.get<AgreementDoc>(`${AFF}/me/agreement`),
  acceptAgreement: () => api.post<{ status: string; code: string | null }>(`${AFF}/me/accept-agreement`, {}),
  conversions: () => api.get<{ conversions: ConversionRow[] }>(`${AFF}/me/conversions`),
  payouts: () => api.get<{ provider: ProviderStatus; payouts: PayoutRow[] }>(`${AFF}/me/payouts`),
  requestPayout: (amountMicros: number) => api.post<{ id: string; status: string }>(`${AFF}/me/payouts`, { amountMicros }),
  createCode: (code: string, campaignLabel?: string) =>
    api.post<{ id: string; code: string }>(`${AFF}/me/codes`, { code, campaignLabel }),
};

/** A stable first-party session id for referral attribution (no PII, per-browser). */
export function affiliateSessionRef(): string {
  const KEY = 'atlas.aff.sref';
  try {
    let v = localStorage.getItem(KEY);
    if (!v) { v = `s_${crypto.randomUUID().replace(/-/g, '')}`; localStorage.setItem(KEY, v); }
    return v;
  } catch {
    return `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}
