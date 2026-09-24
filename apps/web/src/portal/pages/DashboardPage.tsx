import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import type { Route } from '../PortalApp';
import { AccountCard } from './AccountCard';
import { type AccountsView, type Cert, EmptyState, Skeleton } from '../lib';

export function DashboardPage({
  accounts, onOpen, onNav,
}: {
  accounts: AccountsView | null;
  onOpen: (id: string) => void;
  onNav: (n: Route['name']) => void;
}): JSX.Element {
  const [payoutCount, setPayoutCount] = useState<number | null>(null);
  useEffect(() => {
    void api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates')
      .then((r) => setPayoutCount(r.certificates.filter((c) => c.type === 'PAYOUT').length))
      .catch(() => setPayoutCount(0));
  }, []);

  if (!accounts) {
    return (
      <>
        <h1 className="pt-h1">Command center</h1>
        <p className="pt-sub">Loading your authoritative records…</p>
        <Skeleton h={78} />
      </>
    );
  }

  const active = accounts.accounts.filter((a) => a.consumesSlot);
  const funded = active.filter((a) => a.portalState === 'FUNDED_ACTIVE').length;

  return (
    <>
      <h1 className="pt-h1">Command center</h1>
      <p className="pt-sub">What you need to know right now — every figure from your authoritative records.</p>

      <div className="pt-summary" data-testid="pt-summary">
        <div><div className="s-k">Active accounts</div><div className="s-v num">{accounts.activeSlotsUsed} <span style={{ color: 'var(--pt-dim)', fontSize: 15 }}>/ {accounts.maxActiveSlots}</span></div></div>
        <div><div className="s-k">Funded</div><div className="s-v num">{funded}</div></div>
        <div><div className="s-k">Payouts</div><div className="s-v num">{payoutCount ?? '—'}</div></div>
        <div><div className="s-k">Total accounts</div><div className="s-v num">{accounts.accounts.length}</div></div>
      </div>

      <div className="pt-section-title">Your accounts</div>
      {active.length === 0 ? (
        <EmptyState
          title="No active accounts"
          hint="Buy an evaluation to start. Passing, breaching or completing an account frees a slot."
          action={<button className="pt-btn primary" onClick={() => onNav('billing')}>Get an account</button>}
        />
      ) : (
        <div className="pt-cards">
          {active.map((a) => <AccountCard key={a.id} a={a} onOpen={onOpen} />)}
        </div>
      )}
    </>
  );
}
