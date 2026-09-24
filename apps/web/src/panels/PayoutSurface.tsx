/**
 * The trader's payout view.
 *
 * Shows the server's payout eligibility for the selected account — the exact
 * reasons when it is not yet eligible — and lets an eligible trader request a
 * withdrawal within the server's bounds. The page computes nothing: every figure
 * and every gate comes from the server, which is the only authority on whether a
 * payout may happen. A duplicate submit is prevented by an idempotency key and
 * by disabling the button while a request is in flight.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useSession, selectedAccount } from '../state/session';
import { formatMicros } from '../state/format';
import { api } from '../api/client';
import './PayoutSurface.css';

interface Eligibility {
  accountId: string;
  state: 'ELIGIBLE' | 'NOT_ELIGIBLE';
  reasonCodes: string[];
  grossWithdrawableMicros: number;
  qualifyingWinningDays: number;
  requiredWinningDays: number;
  bestDayMicros: number;
  consistencyRatio: number | null;
  payoutConsistencyThreshold: number | null;
  bufferEstablished: boolean;
  fundedBufferMicros: number;
  dailyModeUnlocked: boolean;
  minRequestMicros: number;
  maxRequestMicros: number;
  profitSplitPercent: number;
  model: string;
  balanceMicros: number;
  startingBalanceMicros: number;
}

const REASON_TEXT: Record<string, string> = {
  INSUFFICIENT_WINNING_DAYS: 'You need more qualifying winning days.',
  CONSISTENCY_NOT_MET: 'Your best day is too large a share of total profit. Keep trading to bring it in line.',
  BUFFER_NOT_MET: 'The funded buffer is not established yet.',
  INSUFFICIENT_WITHDRAWABLE_PROFIT: 'There is not enough withdrawable profit above the buffer.',
  ACCOUNT_FAILED: 'This account has failed.',
  ACCOUNT_LOCKED: 'This account is locked.',
  RISK_HOLD: 'A risk review is in progress.',
  FRAUD_HOLD: 'A fraud review is in progress.',
  MANUAL_REVIEW: 'This account is under manual review.',
  ALREADY_PENDING: 'You already have a payout request in progress.',
};

export function PayoutSurface(): JSX.Element {
  const account = useSession(selectedAccount);
  const accountId = account?.id ?? null;
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const idemKey = useMemo(() => `ui-${accountId}-${Date.now()}`, [accountId]);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Eligibility>(`/api/v1/payouts/eligibility/${accountId}`);
      setElig(data);
    } catch (err) {
      setElig(null);
      setError((err as { message?: string }).message ?? 'This account has no payout programme.');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dollars = Number.parseFloat(amount);
  const amountMicros = Number.isFinite(dollars) ? Math.round(dollars * 1_000_000) : NaN;
  const withinBounds =
    elig !== null &&
    Number.isFinite(amountMicros) &&
    amountMicros >= elig.minRequestMicros &&
    amountMicros <= Math.min(elig.maxRequestMicros, elig.grossWithdrawableMicros);

  const submit = useCallback(async () => {
    if (!accountId || !withinBounds) return;
    setSubmitting(true);
    setError(null);
    setOk(null);
    try {
      await api.post('/api/v1/payouts/requests', { accountId, amountMicros, idempotencyKey: idemKey });
      setOk('Payout requested. An operator will review it.');
      setAmount('');
      await load();
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not request the payout.');
    } finally {
      setSubmitting(false);
    }
  }, [accountId, amountMicros, withinBounds, idemKey, load]);

  if (!accountId) return <div className="payout-surface"><p className="pay-muted">Select an account.</p></div>;

  return (
    <div className="payout-surface" data-testid="payout-surface">
      {loading ? <p className="pay-muted">Loading…</p> : null}
      {error && !elig ? <p className="pay-error" data-testid="payout-no-programme">{error}</p> : null}

      {elig ? (
        <>
          <div className="pay-head">
            <span className={`pay-badge ${elig.state === 'ELIGIBLE' ? 'pay-badge-ok' : 'pay-badge-no'}`} data-testid="payout-state">
              {elig.state === 'ELIGIBLE' ? 'Eligible' : 'Not eligible'}
            </span>
            <span className="pay-model">{elig.model} · {(elig.profitSplitPercent * 100).toFixed(0)}% split</span>
          </div>

          <dl className="pay-grid">
            <div><dt>Balance</dt><dd className="num">{formatMicros(elig.balanceMicros)}</dd></div>
            <div><dt>Withdrawable</dt><dd className="num">{formatMicros(elig.grossWithdrawableMicros)}</dd></div>
            <div><dt>Winning days</dt><dd className="num">{elig.qualifyingWinningDays} / {elig.requiredWinningDays}</dd></div>
            {elig.payoutConsistencyThreshold !== null ? (
              <div><dt>Consistency</dt><dd className="num">{elig.consistencyRatio === null ? '—' : `${(elig.consistencyRatio * 100).toFixed(0)}%`} / {(elig.payoutConsistencyThreshold * 100).toFixed(0)}%</dd></div>
            ) : null}
            {elig.fundedBufferMicros > 0 ? (
              <div><dt>Protected buffer</dt><dd className="num">{formatMicros(elig.fundedBufferMicros)} {elig.bufferEstablished ? '✓' : ''}</dd></div>
            ) : null}
            <div><dt>Request range</dt><dd className="num">{formatMicros(elig.minRequestMicros)}–{formatMicros(elig.maxRequestMicros)}</dd></div>
          </dl>

          {elig.state !== 'ELIGIBLE' ? (
            <ul className="pay-reasons" data-testid="payout-reasons">
              {elig.reasonCodes.map((code) => (
                <li key={code}>{REASON_TEXT[code] ?? code}</li>
              ))}
            </ul>
          ) : (
            <div className="pay-request">
              <label htmlFor="pay-amount">Amount (USD)</label>
              <input
                id="pay-amount"
                data-testid="payout-amount"
                type="number"
                min={elig.minRequestMicros / 1_000_000}
                max={Math.min(elig.maxRequestMicros, elig.grossWithdrawableMicros) / 1_000_000}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={`${elig.minRequestMicros / 1_000_000}`}
              />
              {Number.isFinite(amountMicros) && !withinBounds ? (
                <p className="pay-hint">Enter between {formatMicros(elig.minRequestMicros)} and {formatMicros(Math.min(elig.maxRequestMicros, elig.grossWithdrawableMicros))}.</p>
              ) : null}
              {withinBounds ? (
                <p className="pay-hint">You receive {formatMicros(Math.round(amountMicros * elig.profitSplitPercent))} ({(elig.profitSplitPercent * 100).toFixed(0)}%); the account balance falls by {formatMicros(amountMicros)}.</p>
              ) : null}
              <button className="pay-submit" data-testid="payout-submit" disabled={!withinBounds || submitting} onClick={submit}>
                {submitting ? 'Requesting…' : 'Request payout'}
              </button>
            </div>
          )}

          {ok ? <p className="pay-ok" data-testid="payout-ok">{ok}</p> : null}
          {error && elig ? <p className="pay-error">{error}</p> : null}
        </>
      ) : null}
    </div>
  );
}
