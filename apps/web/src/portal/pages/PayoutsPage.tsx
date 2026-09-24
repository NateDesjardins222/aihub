import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { type AccountSummary, EmptyState, familyOf, money } from '../lib';
import { PayoutModule } from './PayoutModule';

/**
 * Payouts home. A trader picks one funded account and sees its authoritative
 * payout picture; the module below reads eligibility from the server and never
 * decides withdrawal terms in the browser.
 */
export function PayoutsPage({
  accounts, selectedId, onToast,
}: {
  accounts: AccountSummary[]; selectedId: string | null; onToast: (m: string) => void;
}): JSX.Element {
  // Only funded accounts can request payouts.
  const fundable = accounts.filter((a) => a.accountType === 'FUNDED_SIM' && a.status === 'ACTIVE');
  const [pick, setPick] = useState<string | null>(() => {
    if (selectedId && fundable.some((a) => a.id === selectedId)) return selectedId;
    return fundable[0]?.id ?? null;
  });
  useEffect(() => {
    setPick((cur) => {
      if (cur && fundable.some((a) => a.id === cur)) return cur;
      if (selectedId && fundable.some((a) => a.id === selectedId)) return selectedId;
      return fundable[0]?.id ?? null;
    });
    // fundable is derived from accounts; keying on the account ids is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, selectedId]);

  return (
    <>
      <h1 className="pt-h1">Payouts</h1>
      <p className="pt-sub">Withdraw your share of funded profit. Every figure here is your firm’s authoritative decision.</p>

      {fundable.length === 0 ? (
        <EmptyState
          title="No funded accounts yet"
          hint="Pass an evaluation to unlock payouts. Payouts are available on funded accounts only."
          action={<button className="pt-btn primary" onClick={() => { window.location.href = '/onboarding'; }}>Get an account</button>}
        />
      ) : (
        <>
          {fundable.length > 1 && (
            <div className="pt-chart-range" data-testid="pt-payout-accounts" style={{ marginBottom: 16 }}>
              {fundable.map((a) => (
                <button key={a.id} className={a.id === pick ? 'on' : ''} onClick={() => setPick(a.id)}>
                  {a.nickname || a.name} · {familyOf(a.product?.key)} · {money(a.balanceMicros)}
                </button>
              ))}
            </div>
          )}
          {pick && <PayoutModule key={pick} accountId={pick} onToast={onToast} />}
        </>
      )}
    </>
  );
}
