/**
 * Portal V2 — development-only visual harness (Product Rebuild Phase 0, STEP 26/27).
 *
 * NOT the customer Portal. Reached only at /portal-v2 in a DEVELOPMENT build
 * (guarded by designLabEnabled() in App.tsx; the route falls through to a 404 in
 * production). No authentication, no session, no real data — every value here is
 * a clearly-labelled representative dev value so Nathan can inspect the V2 design
 * system rapidly when he returns. It renders inside a `.htv2` root, so it uses
 * only `--ht-*` tokens and cannot affect the live V1 Portal.
 */
import { useState, type JSX } from 'react';
import { V2AppShell } from './Shell';
import { V2AccountPanel, type V2AccountView } from './AccountPanel';
import { V2Lifecycle, LIFECYCLE_STAGES } from './Lifecycle';
import { V2AccountsView, type V2AccountsState } from './AccountsView';
import { V2AccountDetail, type DetailTab } from './AccountDetail';
import { toAccountView } from './account-view';
import { FIXTURE_ACCOUNTS, FIXTURE_DETAILS, FIXTURE_VIEW, FIXTURE_VIEW_EMPTY } from './fixtures';
import type { AccountDetailFull, AccountSummary } from '../lib';
import {
  V2Root, V2Metal, V2Button, V2Status, V2Metric, V2FinancialValue,
  V2Section, V2Divider, V2EmptyState, V2Card,
} from './primitives';
import './tokens.css';
import './type.css';

const ACCOUNT_STATES: V2AccountsState[] = [
  { status: 'ready', view: FIXTURE_VIEW },
  { status: 'loading' },
  { status: 'ready', view: FIXTURE_VIEW_EMPTY },
  { status: 'error', message: 'The accounts service is temporarily unavailable (dev fixture).' },
  { status: 'ready', view: FIXTURE_VIEW, degraded: 'Some performance data is delayed; balances below are current.' },
];
const ACCOUNT_STATE_LABELS = ['Ready', 'Loading', 'Empty', 'Error', 'Degraded'];

const DEMO_ACCOUNTS: V2AccountView[] = [
  {
    productLabel: 'CORE 100K', maskedId: '•••• 1005', statusKind: 'evaluation', statusLabel: 'Evaluation',
    portalState: 'EVALUATION_ACTIVE', balanceText: '$100,000', netPnlText: '+$0', netPnlTone: 'muted',
    mllRoomText: '$4,000', progressLabel: 'Profit target', progressPct: 0, progressDetail: '$0 / $6,000', tradable: true,
  },
  {
    productLabel: 'CORE 50K', maskedId: '•••• 2213', statusKind: 'funded', statusLabel: 'Funded',
    portalState: 'FUNDED_ACTIVE', balanceText: '$52,480', netPnlText: '+$2,480', netPnlTone: 'positive',
    mllRoomText: '$4,480', progressLabel: 'Winning days', progressPct: 60, progressDetail: '3 / 5', tradable: true,
  },
  {
    productLabel: 'SELECT 100K', maskedId: '•••• 7788', statusKind: 'failed', statusLabel: 'Breached',
    portalState: 'FAILED', balanceText: '$95,900', netPnlText: '-$4,100', netPnlTone: 'negative',
    mllRoomText: '$0', tradable: false,
  },
];

/** Map a fixture summary id → its detail fixture, so the harness journey uses the
 *  same account the list rendered. Falls back to the evaluation detail. */
const DETAIL_BY_ID: Record<string, AccountDetailFull> = Object.fromEntries(
  Object.values(FIXTURE_DETAILS).map((d) => [d.id, d]),
);

export function PortalV2Harness(): JSX.Element {
  const [active, setActive] = useState('dashboard');
  const [acctState, setAcctState] = useState(0);
  // The isolated Accounts → Detail → Accounts journey (fixtures; no session).
  const [journeyDetail, setJourneyDetail] = useState<AccountDetailFull | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const openDetail = (a: AccountSummary): void => {
    setJourneyDetail(DETAIL_BY_ID[a.id] ?? FIXTURE_DETAILS.evaluationActive!);
    setDetailTab('overview');
  };
  return (
    <V2Root>
      <V2AppShell
        active={active}
        onNavigate={setActive}
        breadcrumb={<span>Portal V2 harness · <strong>DEV ONLY — design-system showcase</strong></span>}
        utilities={<V2Button variant="secondary" size="sm">Account ▾</V2Button>}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ht-space-8)' }}>
          <div>
            <div className="ht-t-page-title"><V2Metal>Happy Trader</V2Metal> — Portal V2 design system</div>
            <p className="ht-t-body-sm" style={{ color: 'var(--ht-text-muted)', marginTop: 6 }}>
              Development-only component harness. Not customer-facing. Values are representative.
            </p>
          </div>

          <V2Section title="Typography">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="ht-t-display ht-num">$128,540.25</div>
              <div className="ht-t-page-title">Page title</div>
              <div className="ht-t-section">Section title</div>
              <div className="ht-t-body">Body text reads in DM Sans with a calm, professional rhythm.</div>
              <div className="ht-t-label">Muted label</div>
              <div className="ht-t-fin-lg ht-num">+$2,480.00</div>
            </div>
          </V2Section>

          <V2Section title="Status">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <V2Status kind="evaluation">Evaluation</V2Status>
              <V2Status kind="funded">Funded</V2Status>
              <V2Status kind="payout">Payout eligible</V2Status>
              <V2Status kind="completed">Completed</V2Status>
              <V2Status kind="failed">Breached</V2Status>
              <V2Status kind="hold">On hold</V2Status>
            </div>
          </V2Section>

          <V2Section title="Buttons">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <V2Button variant="primary">Trade →</V2Button>
              <V2Button variant="secondary">View details</V2Button>
              <V2Button variant="tertiary">Archive</V2Button>
              <V2Button variant="danger">Remove</V2Button>
            </div>
          </V2Section>

          <V2Section title="Metrics">
            <V2Card>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 'var(--ht-space-5)' }}>
                <V2Metric label="Balance" value="$100,000" />
                <V2Metric label="Net P&L" value={<V2FinancialValue tone="positive" size="md">+$2,480</V2FinancialValue>} />
                <V2Metric label="MLL room" value="$4,000" />
                <V2Metric label="Win rate" value="58.2%" sub="212 trades" />
              </div>
            </V2Card>
          </V2Section>

          <V2Section title="Lifecycle (overflow-proof)">
            <V2Card>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 'var(--ht-space-5)' }}>
                <V2Lifecycle portalState="EVALUATION_ACTIVE" />
                <V2Lifecycle portalState="FUNDED_ACTIVE" />
                <V2Lifecycle portalState="COMPLETED_MAX_PAYOUTS" />
              </div>
              <div style={{ marginTop: 16, maxWidth: 220 }}>
                <div className="ht-t-meta" style={{ marginBottom: 6 }}>At 220px — still contained:</div>
                <V2Lifecycle portalState="FUNDED_ACTIVE" stages={LIFECYCLE_STAGES as unknown as string[]} />
              </div>
            </V2Card>
          </V2Section>

          <V2Section title="Account panels (per state)">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 'var(--ht-space-4)' }}>
              {DEMO_ACCOUNTS.map((a) => (
                <V2AccountPanel key={a.maskedId} a={a} />
              ))}
              {/* Every authoritative account state, mapped through the real adapter. */}
              {Object.entries(FIXTURE_ACCOUNTS).map(([key, summary]) => (
                <V2AccountPanel key={key} a={toAccountView(summary)} />
              ))}
            </div>
          </V2Section>

          <V2Section
            title="Accounts experience (states)"
            actions={
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {ACCOUNT_STATE_LABELS.map((label, i) => (
                  <V2Button key={label} variant={i === acctState ? 'primary' : 'secondary'} size="sm" onClick={() => setAcctState(i)}>
                    {label}
                  </V2Button>
                ))}
              </div>
            }
          >
            <V2AccountsView state={ACCOUNT_STATES[acctState]!} actions={{}} />
          </V2Section>

          <V2Section title="Accounts → Detail journey (isolated; fixtures)">
            {journeyDetail ? (
              <V2AccountDetail
                state={{ status: 'ready', detail: journeyDetail }}
                tab={detailTab}
                onTab={setDetailTab}
                actions={{ onBack: () => setJourneyDetail(null), onTrade: () => { /* dev fixture: no real hand-off */ } }}
              />
            ) : (
              <V2AccountsView
                state={{ status: 'ready', view: FIXTURE_VIEW }}
                actions={{ onOpen: openDetail }}
              />
            )}
          </V2Section>

          <V2Section title="Empty state">
            <V2EmptyState title="No payouts yet" hint="When an account becomes payout-eligible it will appear here." action={<V2Button variant="secondary" size="sm">Learn more</V2Button>} />
          </V2Section>

          <V2Divider />
          <p className="ht-t-meta">Portal V2 foundation · Product Rebuild Phase 0 · awaiting Nathan's visual review.</p>
        </div>
      </V2AppShell>
    </V2Root>
  );
}
