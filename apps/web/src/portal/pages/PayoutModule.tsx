import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import { type PayoutEligibility, Card, Metric, money, Money, msg, pct, Skeleton } from '../lib';

/**
 * The payout experience for one funded account.
 *
 * Every number here is the server's own decision, read from
 * GET /api/v1/payouts/eligibility/:accountId — the browser computes no split,
 * no cap, and no eligibility. A request is placed through
 * POST /api/v1/payouts/requests and the server re-decides on its own terms;
 * we never pre-authorise a withdrawal in the client.
 */

/** Turn an authoritative payout reason code into a trader-readable sentence. */
export function reasonText(code: string, el?: PayoutEligibility | null): string {
  switch (code) {
    case 'ELIGIBLE':
      return 'This account is eligible for a payout.';
    case 'INSUFFICIENT_WINNING_DAYS':
      return el
        ? `You need ${el.requiredWinningDays} qualifying winning days — you have ${el.qualifyingWinningDays}.`
        : 'You do not yet have enough qualifying winning days.';
    case 'CONSISTENCY_NOT_MET':
      return el && el.payoutConsistencyThreshold != null
        ? `Your best day is too large a share of profit. No single day may exceed ${pct(el.payoutConsistencyThreshold)} of total profit.`
        : 'Your profit is too concentrated in a single day (consistency rule).';
    case 'BUFFER_NOT_MET':
      return el && el.fundedBufferMicros != null
        ? `Your account must first build a ${money(el.fundedBufferMicros)} profit buffer above its starting balance.`
        : 'Your account has not yet established its required profit buffer.';
    case 'BELOW_MINIMUM':
      return el ? `Requests must be at least ${money(el.minRequestMicros)}.` : 'The amount is below the minimum payout.';
    case 'ABOVE_MAXIMUM':
      return el ? `The most you can request right now is ${money(el.maxRequestMicros)}.` : 'The amount is above the current maximum.';
    case 'INSUFFICIENT_WITHDRAWABLE_PROFIT':
      return 'You do not have enough withdrawable profit above the protected buffer.';
    case 'ACCOUNT_FAILED':
      return 'This account has breached its rules and can no longer request payouts.';
    case 'ACCOUNT_LOCKED':
      return 'This account is locked. Contact support if you believe this is an error.';
    case 'RISK_HOLD':
      return 'A risk review is in progress on this account. Payouts are paused until it clears.';
    case 'FRAUD_HOLD':
      return 'This account is under review. Payouts are paused until the review completes.';
    case 'MANUAL_REVIEW':
      return 'This payout requires a manual review before it can proceed.';
    case 'ALREADY_PENDING':
      return 'You already have a payout request in progress. Only one can be open at a time.';
    default:
      return code.replace(/_/g, ' ').toLowerCase();
  }
}

export function PayoutModule({ accountId, onToast }: { accountId: string; onToast: (m: string) => void }): JSX.Element {
  const [el, setEl] = useState<PayoutEligibility | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = (): void => {
    setEl(null); setErr(null); setDone(null);
    void api.get<PayoutEligibility>(`/api/v1/payouts/eligibility/${accountId}`).then((e) => {
      setEl(e);
      // Default the field to the largest amount the server will accept.
      if (e.state === 'ELIGIBLE') setAmount(String(Math.floor(e.maxRequestMicros / 1_000_000)));
    }).catch((e: unknown) => setErr(msg(e)));
  };
  useEffect(load, [accountId]);

  if (err) return <p className="pt-error">{err}</p>;
  if (!el) return <Skeleton h={220} />;

  const eligible = el.state === 'ELIGIBLE';
  const requestedMicros = amount === '' ? 0 : Math.round(Number(amount) * 1_000_000);
  const traderShareMicros = Math.round(requestedMicros * el.profitSplitPercent);
  const firmShareMicros = requestedMicros - traderShareMicros;
  const withinBounds = requestedMicros >= el.minRequestMicros && requestedMicros <= el.maxRequestMicros;

  const submit = async (): Promise<void> => {
    if (!eligible || !withinBounds) return;
    setBusy(true);
    try {
      const row = await api.post<{ id: string; state: string; requestedGrossMicros: number }>('/api/v1/payouts/requests', {
        accountId, amountMicros: requestedMicros,
      });
      setDone(row.id);
      onToast('Payout requested');
      load();
    } catch (e) {
      onToast(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <div className="pt-row" style={{ alignItems: 'baseline' }}>
          <div className="pt-section-title" style={{ margin: 0 }}>Available to withdraw</div>
          <span className={`pt-badge ${eligible ? 'funded' : 'inactive'}`} data-testid="pt-payout-state">
            <span className="dot" aria-hidden />{eligible ? 'Eligible' : 'Not eligible'}
          </span>
        </div>

        <div className="pt-payout-avail"><Money micros={el.maxRequestMicros} /></div>
        <span className="pt-note" style={{ marginTop: 0 }}>maximum you can request now</span>

        <div className="pt-metrics" style={{ marginTop: 4 }}>
          <Metric label="Withdrawable profit" value={<Money micros={el.grossWithdrawableMicros} />} />
          <Metric label="Your split" value={pct(el.profitSplitPercent)} sub="of every payout" />
          <Metric label="Minimum request" value={<Money micros={el.minRequestMicros} />} />
          <Metric label="Winning days" value={`${el.qualifyingWinningDays} / ${el.requiredWinningDays}`} />
          <Metric label="Consistency" value={el.consistencyRatio == null ? 'n/a' : pct(el.consistencyRatio)}
            sub={el.payoutConsistencyThreshold != null ? `cap ${pct(el.payoutConsistencyThreshold)}` : 'no cap'} />
          <Metric label="Programme" value={el.model} />
        </div>
        {el.fundedBufferMicros != null && (
          <p className="pt-note">
            The first {money(el.fundedBufferMicros)} of profit is a protected buffer{el.bufferEstablished ? ' — established.' : ' and cannot be withdrawn until established.'}
          </p>
        )}
      </Card>

      {eligible ? (
        <Card>
          <div className="pt-section-title" style={{ marginTop: 0 }}>Request a payout</div>
          <div className="pt-ctl-value" style={{ marginBottom: 10 }}>
            <span className="pt-dim">$</span>
            <input
              className="pt-input num"
              data-testid="pt-payout-amount-input"
              type="number"
              min={Math.ceil(el.minRequestMicros / 1_000_000)}
              max={Math.floor(el.maxRequestMicros / 1_000_000)}
              step={50}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              style={{ maxWidth: 180 }}
            />
          </div>
          <div className="pt-metrics">
            <Metric label="You receive (90%)" value={<Money micros={traderShareMicros} />} cls="pos" />
            <Metric label="Firm share (10%)" value={<Money micros={firmShareMicros} />} />
          </div>
          {!withinBounds && amount !== '' && (
            <p className="pt-note">
              {requestedMicros < el.minRequestMicros ? reasonText('BELOW_MINIMUM', el) : reasonText('ABOVE_MAXIMUM', el)}
            </p>
          )}
          <div className="pt-actions" style={{ marginTop: 12 }}>
            <button className="pt-btn primary" data-testid="pt-payout-request" disabled={busy || !withinBounds} onClick={() => void submit()}>
              {busy ? 'Submitting…' : 'Request payout'}
            </button>
          </div>
          {done && <p className="pt-note" data-testid="pt-payout-done">Request submitted. Track its status in your payout history.</p>}
          <p className="pt-note">
            The firm confirms every payout before it is paid. The amount above is debited from the account balance when the request is approved.
          </p>
        </Card>
      ) : (
        <Card>
          <div className="pt-section-title" style={{ marginTop: 0 }}>Why you cannot withdraw yet</div>
          <ul className="pt-reasons" data-testid="pt-payout-reasons">
            {el.reasonCodes.filter((c) => c !== 'ELIGIBLE').map((c) => (
              <li key={c}>{reasonText(c, el)}</li>
            ))}
            {el.reasonCodes.filter((c) => c !== 'ELIGIBLE').length === 0 && (
              <li>This account is not currently eligible for a payout.</li>
            )}
          </ul>
        </Card>
      )}
    </>
  );
}
