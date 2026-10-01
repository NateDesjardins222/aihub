/**
 * Portal V2 — customer destination pages (added at human-rejection #1).
 *
 * Sharp, institutional READ surfaces for the real customer destinations Nathan's
 * sidebar names: Payouts, Certificates, Billing, Support. Each is PRESENTATIONAL —
 * it takes an already-projected view model and renders authoritative records as
 * ledger/table/vault surfaces. In production the container fetches the authoritative
 * endpoints; the dev review supplies clearly dev-only fixtures. No business logic
 * here, no fabricated figures, and every interactive element is a REAL navigation
 * (no dead buttons): records cross-link to the owning account's detail.
 */
import type { JSX } from 'react';
import type { Cert } from '../lib';
import { V2StatStrip, V2Section, V2EmptyState, V2Status, type StatusKind } from './primitives';
import { formatMoney } from './format';
import './pages.css';

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
}

function PageHead({ title, meta, action }: { title: string; meta: string; action?: JSX.Element }): JSX.Element {
  return (
    <header className="htv2-page-head htv2-page-head-row">
      <div>
        <h1 className="ht-t-page-title">{title}</h1>
        <p className="ht-t-meta">{meta}</p>
      </div>
      {action}
    </header>
  );
}

// ============================================================ Payouts =========

export type PayoutState = 'PAID' | 'PROCESSING' | 'APPROVED' | 'UNDER_REVIEW';
export interface PayoutStandingRow {
  accountId: string; accountLabel: string;
  eligible: boolean; availableMicros: number; winningDays: string;
}
export interface PayoutHistoryRow {
  id: string; dateMs: number; accountLabel: string;
  grossMicros: number; traderMicros: number; state: PayoutState;
}
export interface PayoutsView {
  totalPaidMicros: number; availableMicros: number; inReviewMicros: number; cyclesText: string;
  standing: PayoutStandingRow[]; history: PayoutHistoryRow[];
}

const PAYOUT_STATE: Record<PayoutState, { kind: StatusKind; label: string }> = {
  PAID: { kind: 'funded', label: 'Paid' },
  PROCESSING: { kind: 'payout', label: 'Processing' },
  APPROVED: { kind: 'payout', label: 'Approved' },
  UNDER_REVIEW: { kind: 'hold', label: 'In review' },
};

export function V2PayoutsPage({ view, onOpenAccount }: { view: PayoutsView; onOpenAccount: (id: string) => void }): JSX.Element {
  return (
    <div className="htv2-page">
      <PageHead title="Payouts" meta="Your withdrawable profit, payout standing, and settled history." />
      <V2StatStrip
        items={[
          { label: 'Total paid', value: formatMoney(view.totalPaidMicros, { maxFractionDigits: 0 }) },
          { label: 'Available now', value: formatMoney(view.availableMicros, { maxFractionDigits: 0 }), tone: view.availableMicros > 0 ? 'positive' : 'muted' },
          { label: 'In review', value: formatMoney(view.inReviewMicros, { maxFractionDigits: 0 }) },
          { label: 'Payout cycles', value: view.cyclesText },
        ]}
      />

      <V2Section title="Payout standing">
        {view.standing.length === 0 ? (
          <V2EmptyState title="No funded accounts yet" hint="Payout standing appears once you have a funded account." />
        ) : (
          <div className="htv2-rows" data-testid="htv2-payout-standing">
            {view.standing.map((r) => (
              <div className="htv2-row" key={r.accountId}>
                <div className="htv2-row-main">
                  <span className="htv2-row-title ht-t-fin-sm">{r.accountLabel}</span>
                  <span className="ht-t-meta">Winning days {r.winningDays}</span>
                </div>
                <div className="htv2-row-right">
                  <span className="ht-t-fin-sm ht-num">{formatMoney(r.availableMicros)}</span>
                  <V2Status kind={r.eligible ? 'funded' : 'neutral'}>{r.eligible ? 'Eligible' : 'Not yet'}</V2Status>
                  <button className="htv2-link ht-t-nav" onClick={() => onOpenAccount(r.accountId)}>View account →</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </V2Section>

      <V2Section title="History">
        {view.history.length === 0 ? (
          <V2EmptyState title="No payouts yet" hint="Settled payouts will be listed here with their profit split." />
        ) : (
          <div className="htv2-table-wrap">
            <table className="htv2-ledger" data-testid="htv2-payout-history">
              <thead><tr><th>Date</th><th>Account</th><th className="num">Gross</th><th className="num">Your share</th><th>Status</th></tr></thead>
              <tbody>
                {view.history.map((h) => (
                  <tr key={h.id}>
                    <td className="ht-num">{fmtDate(h.dateMs)}</td>
                    <td>{h.accountLabel}</td>
                    <td className="num ht-num">{formatMoney(h.grossMicros)}</td>
                    <td className="num ht-num htv2-tone-positive">{formatMoney(h.traderMicros)}</td>
                    <td><V2Status kind={PAYOUT_STATE[h.state].kind}>{PAYOUT_STATE[h.state].label}</V2Status></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </V2Section>
    </div>
  );
}

// ======================================================= Certificates =========

export function V2CertificatesPage({ certs, onOpenAccount }: { certs: Cert[]; onOpenAccount: (id: string) => void }): JSX.Element {
  const label = (t: string): string => (t === 'FUNDED_TRADER' ? 'Funded Trader' : t === 'PAYOUT' ? 'Payout' : t.replace(/_/g, ' '));
  return (
    <div className="htv2-page">
      <PageHead title="Certificates" meta="Your earned certifications and payout awards, verifiable on the public ledger." />
      {certs.length === 0 ? (
        <V2EmptyState title="No certificates yet" hint="Pass an evaluation or receive a payout and your certificates will appear here." />
      ) : (
        <div className="htv2-vault" data-testid="htv2-certs">
          {certs.map((c) => (
            <article className="htv2-cert" key={c.id}>
              <div className="htv2-cert-top">
                <span className="htv2-cert-kind ht-t-label">{label(c.type)}</span>
                <span className="ht-t-meta ht-num">{fmtDate(c.issuedAt)}</span>
              </div>
              <div className="htv2-cert-name ht-t-section">{c.publicDisplayName}</div>
              {c.amountMicros != null && <div className="htv2-cert-amt ht-t-fin-md ht-num">{formatMoney(c.amountMicros)}</div>}
              <div className="htv2-cert-foot">
                <span className="ht-t-meta ht-num">#{c.certificatePublicId}</span>
                {c.accountId && <button className="htv2-link ht-t-nav" onClick={() => onOpenAccount(c.accountId!)}>View account →</button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================ Billing =========

export type OrderState = 'PAID' | 'REFUNDED' | 'PENDING';
export interface OrderRow {
  id: string; dateMs: number; item: string; amountMicros: number; state: OrderState; accountId?: string | null;
}
export interface BillingView { totalSpentMicros: number; orderCount: number; activeEntitlements: number; orders: OrderRow[] }

const ORDER_STATE: Record<OrderState, { kind: StatusKind; label: string }> = {
  PAID: { kind: 'funded', label: 'Paid' },
  REFUNDED: { kind: 'neutral', label: 'Refunded' },
  PENDING: { kind: 'hold', label: 'Pending' },
};

export function V2BillingPage({ view, onOpenAccount }: { view: BillingView; onOpenAccount: (id: string) => void }): JSX.Element {
  return (
    <div className="htv2-page">
      <PageHead title="Billing" meta="Your purchases, entitlements, and payment history." />
      <V2StatStrip
        items={[
          { label: 'Total spent', value: formatMoney(view.totalSpentMicros, { maxFractionDigits: 0 }) },
          { label: 'Orders', value: String(view.orderCount) },
          { label: 'Active entitlements', value: String(view.activeEntitlements) },
        ]}
      />
      <V2Section title="Order history">
        {view.orders.length === 0 ? (
          <V2EmptyState title="No orders yet" hint="Your evaluation purchases and other orders will appear here." />
        ) : (
          <div className="htv2-table-wrap">
            <table className="htv2-ledger" data-testid="htv2-billing-orders">
              <thead><tr><th>Date</th><th>Item</th><th className="num">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {view.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="ht-num">{fmtDate(o.dateMs)}</td>
                    <td>{o.item}</td>
                    <td className="num ht-num">{formatMoney(o.amountMicros)}</td>
                    <td><V2Status kind={ORDER_STATE[o.state].kind}>{ORDER_STATE[o.state].label}</V2Status></td>
                    <td className="num">{o.accountId ? <button className="htv2-link ht-t-nav" onClick={() => onOpenAccount(o.accountId!)}>View account →</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </V2Section>
    </div>
  );
}

// ============================================================ Support =========

export type TicketState = 'OPEN' | 'WAITING' | 'RESOLVED';
export interface TicketRow { id: string; subject: string; state: TicketState; updatedMs: number; ref: string }
export interface SupportView { openCount: number; tickets: TicketRow[] }

const TICKET_STATE: Record<TicketState, { kind: StatusKind; label: string }> = {
  OPEN: { kind: 'evaluation', label: 'Open' },
  WAITING: { kind: 'hold', label: 'Awaiting you' },
  RESOLVED: { kind: 'completed', label: 'Resolved' },
};

export function V2SupportPage({ view }: { view: SupportView }): JSX.Element {
  return (
    <div className="htv2-page">
      <PageHead title="Support" meta="Your requests and their status. Replies arrive by email and here." />
      {view.tickets.length === 0 ? (
        <V2EmptyState title="No requests yet" hint="When you contact support, your conversation and its status appear here." />
      ) : (
        <V2Section title="Your requests" actions={<span className="ht-t-meta">{view.openCount} open</span>}>
          <div className="htv2-table-wrap">
            <table className="htv2-ledger" data-testid="htv2-support-tickets">
              <thead><tr><th>Reference</th><th>Subject</th><th>Status</th><th className="num">Updated</th></tr></thead>
              <tbody>
                {view.tickets.map((t) => (
                  <tr key={t.id}>
                    <td className="ht-num">{t.ref}</td>
                    <td>{t.subject}</td>
                    <td><V2Status kind={TICKET_STATE[t.state].kind}>{TICKET_STATE[t.state].label}</V2Status></td>
                    <td className="num ht-num">{fmtDate(t.updatedMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </V2Section>
      )}
    </div>
  );
}

// ====================================================== Owner notice =========

/**
 * Owner entry target. Owner Console is a SEPARATE, server-authorized application at
 * /admin — never rendered inside the customer portal. This truthful notice is reached
 * only from the account menu's owner-only entry (dev `?role=owner`).
 */
export function V2OwnerNotice({ onOpenAdmin, onBack }: { onOpenAdmin: () => void; onBack: () => void }): JSX.Element {
  return (
    <div className="htv2-page">
      <PageHead title="Owner Console" meta="Operator tools live in a separate, server-authorized application." />
      <V2EmptyState
        title="Owner Console is a separate application"
        hint="The operator console is served at /admin and authorized server-side. It is not part of the customer portal; this entry appears only because the owner role override is active."
      />
      <div className="htv2-page-actions">
        <button className="htv2-link ht-t-nav" onClick={onBack}>← Back to dashboard</button>
        <button className="htv2-btn htv2-btn-secondary htv2-btn-sm ht-t-button" onClick={onOpenAdmin}>Open Owner Console ↗</button>
      </div>
    </div>
  );
}
