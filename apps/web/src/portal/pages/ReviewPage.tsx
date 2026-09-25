/*
 * The trader-facing "Account review" page (M7).
 *
 * A review is not an accusation. This page tells a trader, in plain and
 * respectful language, only what they need to know: that something is being
 * checked, which of their capabilities is temporarily paused (if any), what
 * they can do to help, and — where a serious final decision has been made —
 * that they may appeal. It never shows internal notes, evidence, severity or
 * reason codes. Everything here is a customer-safe server read; the browser
 * decides nothing.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client';
import { Card, EmptyState, msg } from '../lib';

interface CustomerCaseView {
  reference: string;
  status: string;
  reason: string;
  openedAt: number;
  temporaryHolds: string[];
  informationRequest: { id: string; requestType: string; message: string; dueAt: number | null; responded: boolean } | null;
  appeal: { id: string; status: string; explanation: string | null } | null;
  appealAvailable: boolean;
}

const REASON_TEXT: Record<string, string> = {
  ACCOUNT_OWNERSHIP_VERIFICATION: 'We are confirming that this account is operated by its verified owner.',
  IDENTITY_VERIFICATION: 'We are verifying some identity details on your profile.',
  PAYMENT_REVIEW: 'We are reviewing a payment on your account.',
  PAYOUT_REVIEW: 'We are reviewing a payout before it is released.',
  SECURITY_REVIEW: 'We are checking recent security activity to keep your account safe.',
  GENERAL_REVIEW: 'Your account is under a routine review.',
};

const HOLD_TEXT: Record<string, string> = {
  TRADING: 'New position-opening is paused. You can still close or reduce open positions at any time.',
  PAYOUT_REQUEST: 'Requesting a new payout is paused while we review.',
  PAYOUT_APPROVAL: 'A payout is paused pending review; it has not been declined.',
  PURCHASE: 'Buying a new account is paused while we review.',
  ACCESS: 'Some account access is temporarily limited.',
};

function statusLabel(s: string): string {
  switch (s) {
    case 'AWAITING_CUSTOMER': return 'Waiting for your response';
    case 'CONFIRMED_VIOLATION': return 'Decision made';
    case 'OVERTURNED': return 'Resolved in your favour';
    case 'RESOLVED_REMEDIATED': return 'Resolved';
    case 'APPEALED':
    case 'APPEAL_REVIEW': return 'Appeal under review';
    default: return 'Under review';
  }
}

export function ReviewPage({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [cases, setCases] = useState<CustomerCaseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void api.get<{ cases: CustomerCaseView[] }>('/api/v1/portal/enforcement/cases')
      .then((r) => setCases(r.cases))
      .catch((e) => { setError(msg(e)); setCases([]); });
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <h1 className="pt-h1">Account review</h1>
      <p className="pt-sub">
        Reviews are a normal part of keeping the platform fair and secure. A review is not a decision,
        and being profitable is never a problem. If we need anything from you, it will appear here.
      </p>

      {error ? <Card><p className="muted">{error}</p></Card> : null}

      {cases === null ? (
        <Card><p className="muted">Loading…</p></Card>
      ) : cases.length === 0 ? (
        <EmptyState title="Nothing to review" hint="There are no reviews on your account. If that changes, you will see it here and we will email you." />
      ) : (
        <div className="pt-cards">
          {cases.map((c) => (
            <ReviewCard key={c.reference} c={c} onChanged={load} onToast={onToast} />
          ))}
        </div>
      )}

      <Card>
        <h3>See something wrong?</h3>
        <p className="muted">
          If you don’t recognise a login, a purchase, or a change to your payout details, tell us and we
          will look into it. Reporting never counts against you.
        </p>
        <ReportControls onToast={onToast} />
      </Card>
    </>
  );
}

function ReviewCard({ c, onChanged, onToast }: { c: CustomerCaseView; onChanged: () => void; onToast: (m: string) => void }): JSX.Element {
  const [respText, setRespText] = useState('');
  const [appealText, setAppealText] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAppeal, setShowAppeal] = useState(false);

  const respond = useCallback(async () => {
    if (!c.informationRequest || respText.trim().length === 0) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/portal/enforcement/info-requests/${c.informationRequest.id}/respond`, { responseText: respText.trim() });
      onToast('Thank you — your response was received.');
      setRespText('');
      onChanged();
    } catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  }, [c.informationRequest, respText, onChanged, onToast]);

  const appeal = useCallback(async () => {
    if (appealText.trim().length === 0) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/portal/enforcement/cases/${c.reference}/appeal`, { statement: appealText.trim() });
      onToast('Your appeal has been submitted and will be reviewed independently.');
      setAppealText('');
      setShowAppeal(false);
      onChanged();
    } catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  }, [appealText, c.reference, onChanged, onToast]);

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ margin: 0 }}>{statusLabel(c.status)}</h3>
        <span className="muted" style={{ fontSize: 12 }}>Ref {c.reference}</span>
      </div>
      <p className="muted">{REASON_TEXT[c.reason] ?? c.reason}</p>

      {c.temporaryHolds.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <strong style={{ fontSize: 13 }}>While we review</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {c.temporaryHolds.map((h) => <li key={h} className="muted" style={{ marginBottom: 4 }}>{HOLD_TEXT[h] ?? `${h} is temporarily paused.`}</li>)}
          </ul>
        </div>
      ) : null}

      {c.informationRequest && !c.informationRequest.responded ? (
        <div style={{ marginTop: 12 }}>
          <strong style={{ fontSize: 13 }}>We’ve asked for something</strong>
          <p className="muted" style={{ marginTop: 4 }}>{c.informationRequest.message}</p>
          <textarea
            className="pt-input"
            data-testid={`review-respond-${c.reference}`}
            rows={3}
            placeholder="Type your response"
            value={respText}
            onChange={(e) => setRespText(e.target.value)}
            style={{ width: '100%', marginTop: 6 }}
          />
          <div className="pt-actions" style={{ marginTop: 8 }}>
            <button className="pt-btn" disabled={busy || respText.trim().length === 0} onClick={respond}>Send response</button>
          </div>
        </div>
      ) : null}

      {c.appeal ? (
        <p className="muted" style={{ marginTop: 12 }}>
          <strong>Appeal:</strong> {c.appeal.status.replace(/_/g, ' ').toLowerCase()}
          {c.appeal.explanation ? ` — ${c.appeal.explanation}` : ''}
        </p>
      ) : c.appealAvailable ? (
        <div style={{ marginTop: 12 }}>
          {!showAppeal ? (
            <button className="pt-link" data-testid={`review-appeal-open-${c.reference}`} onClick={() => setShowAppeal(true)}>
              You have the right to appeal this decision →
            </button>
          ) : (
            <>
              <strong style={{ fontSize: 13 }}>Appeal this decision</strong>
              <p className="muted" style={{ marginTop: 4 }}>
                Your appeal is reviewed by someone other than the person who made the original decision.
                Tell us anything you think we should know.
              </p>
              <textarea
                className="pt-input"
                data-testid={`review-appeal-text-${c.reference}`}
                rows={4}
                placeholder="Your appeal"
                value={appealText}
                onChange={(e) => setAppealText(e.target.value)}
                style={{ width: '100%', marginTop: 6 }}
              />
              <div className="pt-actions" style={{ marginTop: 8 }}>
                <button className="pt-btn" disabled={busy || appealText.trim().length === 0} onClick={appeal} data-testid={`review-appeal-submit-${c.reference}`}>Submit appeal</button>
                <button className="pt-link" onClick={() => setShowAppeal(false)}>Cancel</button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function ReportControls({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [kind, setKind] = useState('CUSTOMER_REPORTED_ACCESS');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    setBusy(true);
    try {
      await api.post('/api/v1/portal/enforcement/report', { kind, detail: detail.trim() || undefined });
      onToast('Thank you — we’ve received your report and will look into it.');
      setDetail('');
    } catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  }, [kind, detail, onToast]);

  return (
    <div style={{ marginTop: 8 }}>
      <select className="pt-input" value={kind} onChange={(e) => setKind(e.target.value)} data-testid="review-report-kind">
        <option value="CUSTOMER_REPORTED_ACCESS">I don’t recognise a login / access</option>
        <option value="CUSTOMER_REPORTED_PURCHASE">I don’t recognise a purchase</option>
        <option value="CUSTOMER_REPORTED_PAYOUT_CHANGE">I didn’t change my payout details</option>
      </select>
      <textarea
        className="pt-input"
        rows={2}
        placeholder="Anything else we should know (optional)"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        style={{ width: '100%', marginTop: 6 }}
        data-testid="review-report-detail"
      />
      <div className="pt-actions" style={{ marginTop: 8 }}>
        <button className="pt-btn" disabled={busy} onClick={submit} data-testid="review-report-submit">Report it</button>
      </div>
    </div>
  );
}
