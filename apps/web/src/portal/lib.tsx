/**
 * Happy Trader portal — shared formatting, API types, and premium UI primitives.
 * All money is integer micro-dollars from the server; nothing here computes
 * financial truth. Values render with tabular numerals for column alignment.
 */
import type { JSX, ReactNode } from 'react';
import { ApiRequestError } from '../api/client';
import type { PersonalRiskProfileView } from '@atlas/contracts';

export const M = 1_000_000;

export function money(micros: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (micros == null) return '—';
  const v = micros / M;
  const sign = v < 0 ? '-' : opts.sign && v > 0 ? '+' : '';
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
export function pct(x: number | null | undefined): string {
  return x == null ? '—' : `${(x * 100).toFixed(1)}%`;
}
export function tone(micros: number | null | undefined): 'pos' | 'neg' | 'flat' {
  if (micros == null || micros === 0) return 'flat';
  return micros > 0 ? 'pos' : 'neg';
}

export function stateLabel(s: string): string {
  return (
    ({
      EVALUATION_ACTIVE: 'Evaluation', FUNDED_ACTIVE: 'Funded', EVALUATION_PASSED: 'Passed',
      FAILED: 'Breached', COMPLETED_MAX_PAYOUTS: 'Completed', INACTIVE_CLOSED: 'Closed',
      ARCHIVED: 'Archived', PENDING: 'Pending',
    } as Record<string, string>)[s] ?? s
  );
}
export function badgeClass(s: string): string {
  return (
    ({
      EVALUATION_ACTIVE: 'eval', FUNDED_ACTIVE: 'funded', EVALUATION_PASSED: 'passed',
      FAILED: 'failed', COMPLETED_MAX_PAYOUTS: 'completed', INACTIVE_CLOSED: 'inactive',
      ARCHIVED: 'archived', PENDING: 'pending',
    } as Record<string, string>)[s] ?? 'eval'
  );
}
export function achLabel(t: string): string {
  return (
    ({
      FUNDED: 'Funded Trader', FIRST_PAYOUT: 'First Payout', PAID_5K: '$5K Paid', PAID_10K: '$10K Paid',
      PAID_25K: '$25K Paid', FIVE_PAYOUT_CLUB: 'Five-Payout Club', ACCOUNT_COMPLETED: 'Account Completed',
    } as Record<string, string>)[t] ?? t
  );
}
export function certLabel(t: string): string {
  return (
    ({ EVALUATION_PASSED: 'Evaluation Passed', FUNDED_TRADER: 'Funded Trader', PAYOUT: 'Payout', ACCOUNT_COMPLETED: 'Account Completed' } as Record<string, string>)[
      t
    ] ?? t
  );
}
export function msg(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return e instanceof Error ? e.message : 'Something went wrong.';
}
export function familyOf(productKey: string | null | undefined): string {
  if (!productKey) return '';
  if (productKey.includes('select')) return 'SELECT';
  if (productKey.includes('daily')) return 'DAILY';
  if (productKey.includes('gold')) return 'GOLD';
  return 'CORE';
}

// ---- API projection types (mirror the server) -----------------------------
export interface AccountSummary {
  id: string; publicId: string; name: string; nickname: string | null; accountType: string;
  status: string; portalState: string; consumesSlot: boolean;
  product: { key: string; name: string; version: number } | null;
  startingBalanceMicros: number; balanceMicros: number; highWaterMarkMicros: number;
  drawdownFloorMicros: number; resetOfAccountId: string | null; archivedAt: number | null; createdAt: number;
}
export interface AccountsView { accounts: AccountSummary[]; activeSlotsUsed: number; maxActiveSlots: number }
export interface Breakdown { key: string; trades: number; netPnlMicros: number; winRate: number | null }
export interface Analytics {
  accountId: string; currentBalanceMicros: number; startingBalanceMicros: number;
  currentDrawdownMicros: number; mllHeadroomMicros: number; highWaterMarkMicros: number; drawdownFloorMicros: number;
  trades: {
    totalTrades: number; winningTrades: number; losingTrades: number; breakevenTrades: number;
    winRate: number | null; lossRate: number | null; profitFactor: number | null; netPnlMicros: number;
    grossProfitMicros: number; grossLossMicros: number; feesMicros: number; expectancyMicros: number;
    averageTradeMicros: number; averageWinMicros: number; averageLossMicros: number;
    largestWinMicros: number; largestLossMicros: number; averageRMultiple: number | null; rSampleSize: number;
    averageTradeDurationMs: number | null;
  };
  streaks: { currentStreak: number; bestWinStreak: number; worstLossStreak: number };
  days: {
    totalTradingDays: number; profitableDays: number; losingDays: number; percentProfitableDays: number | null;
    bestDayMicros: number; worstDayMicros: number; averageDailyPnlMicros: number;
  };
  equity: { points: Array<{ tExitMs: number; equityMicros: number; drawdownMicros: number }>; maxDrawdownMicros: number; finalEquityMicros: number };
  breakdowns: { byInstrument: Breakdown[]; bySide: Breakdown[]; byDayOfWeek?: Breakdown[] };
}
export interface Cert { id: string; certificatePublicId: string; verificationToken: string; type: string; publicDisplayName: string; amountMicros: number | null; status: string; issuedAt: number }
export interface Achievement { id: string; type: string; isPublic: boolean; meta: Record<string, unknown> | null; earnedAt: number }
export interface AchievementsView { achievementsPublic: boolean; achievements: Achievement[] }
export interface LifecycleEntry { seq: number; startedAt: number; endedAt: number | null; endReason: string | null; finalStatus: string | null; startingBalanceMicros: number }
export type AccountDetailFull = AccountSummary & { realizedPnlMicros?: number; feesMicros?: number; priceMicros?: number | null; lifecycles?: LifecycleEntry[] };
export interface PayoutEligibility {
  accountId: string; state: 'ELIGIBLE' | 'NOT_ELIGIBLE'; reasonCodes: string[];
  grossWithdrawableMicros: number; qualifyingWinningDays: number; requiredWinningDays: number;
  bestDayMicros: number; consistencyRatio: number | null; payoutConsistencyThreshold: number | null;
  bufferEstablished: boolean; fundedBufferMicros: number | null; dailyModeUnlocked: boolean;
  minRequestMicros: number; maxRequestMicros: number; profitSplitPercent: number; model: string;
  balanceMicros: number; startingBalanceMicros: number;
}
export type { PersonalRiskProfileView };

// ---- Primitives ------------------------------------------------------------
export function Card({ children, className = '', pad = true }: { children: ReactNode; className?: string; pad?: boolean }): JSX.Element {
  return <section className={`pt-card ${pad ? '' : 'pt-card-flush'} ${className}`}>{children}</section>;
}

export function Money({ micros, sign, className = '' }: { micros: number | null | undefined; sign?: boolean; className?: string }): JSX.Element {
  return <span className={`num ${tone(micros)} ${className}`}>{money(micros, { sign })}</span>;
}

export function Metric({ label, value, sub, cls }: { label: string; value: ReactNode; sub?: ReactNode; cls?: string }): JSX.Element {
  return (
    <div className="pt-metric">
      <div className="pt-metric-k">{label}</div>
      <div className={`pt-metric-v num ${cls ?? ''}`}>{value}</div>
      {sub != null && <div className="pt-metric-sub">{sub}</div>}
    </div>
  );
}

export function Pill({ state, children }: { state: string; children?: ReactNode }): JSX.Element {
  return (
    <span className={`pt-badge ${badgeClass(state)}`}>
      <span className="dot" aria-hidden />
      {children ?? stateLabel(state)}
    </span>
  );
}

export function Toggle({ on, onClick, label, disabled }: { on: boolean; onClick: () => void; label?: string; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={`pt-toggle-btn${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="pt-toggle-track"><span className="pt-toggle-thumb" /></span>
      {label != null && <span className="pt-toggle-label">{label}</span>}
    </button>
  );
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }): JSX.Element {
  return <span className="pt-skeleton" style={{ height: h, width: w }} aria-hidden />;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="pt-empty">
      <div className="pt-empty-title">{title}</div>
      {hint != null && <p className="pt-empty-hint">{hint}</p>}
      {action}
    </div>
  );
}

/** The compact lifecycle path: Evaluation → Funded → Payouts → Completed. */
export function AccountPath({ portalState, detail }: { portalState: string; detail?: string }): JSX.Element {
  const steps = ['Evaluation', 'Funded', 'Payouts', 'Completed'];
  const active = ((): number => {
    switch (portalState) {
      case 'PENDING':
      case 'EVALUATION_ACTIVE':
        return 0;
      case 'EVALUATION_PASSED':
      case 'FUNDED_ACTIVE':
        return 1;
      case 'COMPLETED_MAX_PAYOUTS':
        return 3;
      default:
        return -1; // FAILED / INACTIVE / ARCHIVED — no path highlight
    }
  })();
  const failed = portalState === 'FAILED';
  return (
    <div className={`pt-path${failed ? ' failed' : ''}`} aria-label="Account lifecycle">
      {steps.map((s, i) => (
        <div key={s} className={`pt-path-step${i <= active ? ' done' : ''}${i === active ? ' at' : ''}`}>
          <span className="pt-path-dot" aria-hidden />
          <span className="pt-path-label">{s}</span>
        </div>
      ))}
      {detail != null && <span className="pt-path-detail">{detail}</span>}
    </div>
  );
}
