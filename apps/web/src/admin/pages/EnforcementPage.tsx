/**
 * The owner Enforcement workspace (M7).
 *
 * A place to run reviews, not to convict. Everything on screen is a server read:
 * the queue, the signals, the holds, the cases and their findings/actions/appeals.
 * The console recommends nothing and computes no "fraud score" — there is none.
 * The whole design keeps three separations visible at all times: a SIGNAL is not
 * a FINDING, a TEMPORARY HOLD is not a CONVICTION, and a rule breach is not
 * misconduct. Punitive actions and serious findings are gated to SUPER_ADMIN by
 * the server; this UI only hides the buttons a role may not use.
 */
import { useCallback, useState, type JSX } from 'react';
import { adminApi } from '../api';
import { ConfirmAction, Panel, Stat, StatusPill, useLoad, when } from '../shared';
import type { EnfCaseDetail } from '../types';

type Tab = 'QUEUE' | 'CASES' | 'APPEALS' | 'HOLDS' | 'SIGNALS';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'QUEUE', label: 'Review queue' },
  { key: 'CASES', label: 'Cases' },
  { key: 'APPEALS', label: 'Appeals' },
  { key: 'HOLDS', label: 'Holds' },
  { key: 'SIGNALS', label: 'Signals' },
];

const OPEN_STATUSES = ['OPEN', 'TRIAGED', 'UNDER_REVIEW', 'AWAITING_CUSTOMER', 'ESCALATED'];

export function AdminEnforcementPage({
  mayMutate,
  maySuper,
}: {
  mayMutate: boolean;
  maySuper: boolean;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('QUEUE');
  const [openId, setOpenId] = useState<string | null>(null);
  const summary = useLoad(() => adminApi.enfSummary(), []);
  const s = summary.data;

  return (
    <div className="adm-page">
      <Panel title="Enforcement">
        <div className="adm-stats">
          <Stat label="Open cases" value={s ? s.openCases : '—'} />
          <Stat label="Active holds" value={s ? s.holds : '—'} />
          <Stat label="Open appeals" value={s ? s.appeals : '—'} />
        </div>
        <p className="adm-muted">
          A case is a review, not a verdict. Severity is triage urgency, not guilt. A signal is not a
          finding; a temporary hold is not a conviction; a rule breach (MLL, consistency, daily
          progression, personal risk) is <strong>not</strong> misconduct and is never recorded here.
          Profitability, a VPN, a new device, travel and a chargeback are never, by themselves, proof
          of anything.
        </p>
      </Panel>

      <Panel
        title="Workspace"
        action={
          <div className="adm-tabs" role="tablist" aria-label="Enforcement view">
            {TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={tab === t.key}
                className={`adm-tab ${tab === t.key ? 'adm-tab-on' : ''}`}
                onClick={() => { setTab(t.key); setOpenId(null); }}
                data-testid={`enf-tab-${t.key.toLowerCase()}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        {tab === 'QUEUE' ? <CaseList filter={{}} onlyOpen onOpen={setOpenId} openId={openId} /> : null}
        {tab === 'CASES' ? <CaseList filter={{}} onOpen={setOpenId} openId={openId} /> : null}
        {tab === 'APPEALS' ? <AppealsList onOpen={setOpenId} /> : null}
        {tab === 'HOLDS' ? <HoldsList mayMutate={mayMutate} /> : null}
        {tab === 'SIGNALS' ? <SignalsList /> : null}
      </Panel>

      {openId ? (
        <CaseDetailPanel
          id={openId}
          mayMutate={mayMutate}
          maySuper={maySuper}
          onChanged={() => summary.reload()}
        />
      ) : null}
    </div>
  );
}

function CaseList({
  filter,
  onlyOpen,
  onOpen,
  openId,
}: {
  filter: { status?: string; severity?: string; category?: string };
  onlyOpen?: boolean;
  onOpen: (id: string) => void;
  openId: string | null;
}): JSX.Element {
  const { data, error, loading } = useLoad(() => adminApi.enfCases(filter), [JSON.stringify(filter)]);
  const rows = (data?.cases ?? []).filter((c) => (onlyOpen ? OPEN_STATUSES.includes(c.status) : true));
  if (loading) return <p className="adm-muted">Loading…</p>;
  if (error) return <p className="adm-error">{error}</p>;
  return (
    <table className="adm-table" data-testid="enf-cases">
      <thead>
        <tr>
          <th>Ref</th>
          <th>Category</th>
          <th>Severity</th>
          <th>Status</th>
          <th>Opened</th>
          <th className="adm-actions-col">Case</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id} data-testid={`enf-case-${c.id}`}>
            <td><code>{c.publicRef}</code></td>
            <td className="adm-dim">{c.category.replace(/_/g, ' ').toLowerCase()}</td>
            <td><StatusPill status={c.severity} /></td>
            <td><StatusPill status={c.status} /></td>
            <td className="adm-dim">{when(Date.parse(c.openedAt))}</td>
            <td className="adm-actions-col">
              <button className="adm-btn" onClick={() => onOpen(openId === c.id ? '' : c.id)} data-testid={`enf-open-${c.id}`}>
                {openId === c.id ? 'Hide' : 'Open'}
              </button>
            </td>
          </tr>
        ))}
        {rows.length === 0 ? <tr><td colSpan={6} className="adm-muted">Nothing here.</td></tr> : null}
      </tbody>
    </table>
  );
}

function AppealsList({ onOpen }: { onOpen: (id: string) => void }): JSX.Element {
  // Appeals live on their cases; the queue shows appealed cases so an operator
  // opens the case to see the appeal, the original (immutable) finding and decide.
  const { data, error, loading } = useLoad(() => adminApi.enfCases({}), []);
  const rows = (data?.cases ?? []).filter((c) => c.status === 'APPEALED' || c.status === 'APPEAL_REVIEW');
  if (loading) return <p className="adm-muted">Loading…</p>;
  if (error) return <p className="adm-error">{error}</p>;
  return (
    <table className="adm-table" data-testid="enf-appeals">
      <thead><tr><th>Ref</th><th>Category</th><th>Status</th><th>Opened</th><th className="adm-actions-col">Case</th></tr></thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.id}>
            <td><code>{c.publicRef}</code></td>
            <td className="adm-dim">{c.category.replace(/_/g, ' ').toLowerCase()}</td>
            <td><StatusPill status={c.status} /></td>
            <td className="adm-dim">{when(Date.parse(c.openedAt))}</td>
            <td className="adm-actions-col"><button className="adm-btn" onClick={() => onOpen(c.id)}>Open</button></td>
          </tr>
        ))}
        {rows.length === 0 ? <tr><td colSpan={5} className="adm-muted">No open appeals.</td></tr> : null}
      </tbody>
    </table>
  );
}

function HoldsList({ mayMutate }: { mayMutate: boolean }): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => adminApi.enfHolds({ status: 'ACTIVE' }), []);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = data?.holds ?? [];
  const release = useCallback(async (id: string) => {
    setBusy(id);
    try { await adminApi.enfReleaseHold(id, 'Released from holds view'); reload(); } finally { setBusy(null); }
  }, [reload]);
  if (loading) return <p className="adm-muted">Loading…</p>;
  if (error) return <p className="adm-error">{error}</p>;
  return (
    <>
      <p className="adm-muted">
        A hold pauses one capability while facts are checked. A trading hold never blocks a
        risk-reducing or closing order — a trader can always flatten a position. Releasing a hold is
        immediate and audited.
      </p>
      <table className="adm-table" data-testid="enf-holds">
        <thead><tr><th>Scope</th><th>Capability</th><th>Reason</th><th>Source</th><th>Placed</th><th>Expires</th><th className="adm-actions-col" /></tr></thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id} data-testid={`enf-hold-${h.id}`}>
              <td className="adm-dim">{h.scope.toLowerCase()}</td>
              <td><StatusPill status={h.capability} /></td>
              <td className="adm-dim">{h.reasonCode}</td>
              <td className="adm-dim">{h.createdBySystem ? 'system' : 'operator'}</td>
              <td className="adm-dim">{when(Date.parse(h.createdAt))}</td>
              <td className="adm-dim">{h.expiresAt ? when(Date.parse(h.expiresAt)) : '—'}</td>
              <td className="adm-actions-col">
                {mayMutate ? (
                  <button className="adm-btn" disabled={busy === h.id} onClick={() => release(h.id)}>Release</button>
                ) : null}
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={7} className="adm-muted">No active holds.</td></tr> : null}
        </tbody>
      </table>
    </>
  );
}

function SignalsList(): JSX.Element {
  const { data, error, loading } = useLoad(() => adminApi.enfSignals(), []);
  const rows = data?.signals ?? [];
  if (loading) return <p className="adm-muted">Loading…</p>;
  if (error) return <p className="adm-error">{error}</p>;
  return (
    <>
      <p className="adm-muted">
        Signals are raw observations — a new device, a VPN, a chargeback notice. A signal is never a
        finding and never, by itself, an accusation. Most are informational and open no case.
      </p>
      <table className="adm-table" data-testid="enf-signals">
        <thead><tr><th>Source</th><th>Kind</th><th>Severity</th><th>Case?</th><th>Observed</th></tr></thead>
        <tbody>
          {rows.map((sig) => (
            <tr key={sig.id}>
              <td className="adm-dim">{sig.source.toLowerCase()}</td>
              <td className="adm-dim">{sig.kind}</td>
              <td><StatusPill status={sig.severity} /></td>
              <td>{sig.caseId ? <span className="adm-pill adm-status-open">case</span> : <span className="adm-dim">—</span>}</td>
              <td className="adm-dim">{when(Date.parse(sig.occurredAt))}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={5} className="adm-muted">No signals.</td></tr> : null}
        </tbody>
      </table>
    </>
  );
}

// The case-detail workbench — read everything, and act where the role permits.
const NEXT_STATUSES: Record<string, string[]> = {
  OPEN: ['TRIAGED', 'UNDER_REVIEW', 'RESOLVED_NO_ACTION', 'ESCALATED'],
  TRIAGED: ['UNDER_REVIEW', 'AWAITING_CUSTOMER', 'ESCALATED', 'RESOLVED_NO_ACTION'],
  UNDER_REVIEW: ['AWAITING_CUSTOMER', 'ESCALATED', 'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'CONFIRMED_VIOLATION'],
  AWAITING_CUSTOMER: ['UNDER_REVIEW', 'ESCALATED', 'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'CONFIRMED_VIOLATION'],
  ESCALATED: ['UNDER_REVIEW', 'RESOLVED_NO_ACTION', 'RESOLVED_REMEDIATED', 'CONFIRMED_VIOLATION'],
  CONFIRMED_VIOLATION: ['APPEALED', 'FINALIZED'],
  APPEALED: ['APPEAL_REVIEW'],
  APPEAL_REVIEW: ['OVERTURNED', 'FINALIZED', 'RESOLVED_REMEDIATED', 'AWAITING_CUSTOMER'],
  FINALIZED: ['APPEALED'],
};

const HOLD_CAPS = ['TRADING', 'PAYOUT_REQUEST', 'PAYOUT_APPROVAL', 'PURCHASE', 'ACCESS'];
const ADVERSE_FINDINGS = [
  'ACCOUNT_SHARING_CONFIRMED', 'IDENTITY_FRAUD_CONFIRMED', 'PAYMENT_FRAUD_CONFIRMED',
  'PAYOUT_FRAUD_CONFIRMED', 'PAYOUT_DUPLICATION_CONFIRMED', 'PLATFORM_EXPLOIT_CONFIRMED',
  'AUTOMATION_ABUSE_CONFIRMED', 'UNAUTHORIZED_ACCESS_CONFIRMED', 'COLLUSION_CONFIRMED',
];
const SAFE_ACTIONS = ['STEP_UP_VERIFICATION', 'FORCE_SESSION_REAUTH', 'REVOKE_SESSIONS', 'REQUEST_INFORMATION', 'REMOVE_HOLD', 'NO_ACTION'];
const PUNITIVE_ACTIONS = ['ACCOUNT_TERMINATION', 'CUSTOMER_TERMINATION'];

function CaseDetailPanel({
  id,
  mayMutate,
  maySuper,
  onChanged,
}: {
  id: string;
  mayMutate: boolean;
  maySuper: boolean;
  onChanged: () => void;
}): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => adminApi.enfCase(id), [id]);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ label: string; run: (reason: string) => Promise<void> } | null>(null);
  const [note, setNote] = useState('');
  const [holdCap, setHoldCap] = useState('TRADING');
  const [findingCode, setFindingCode] = useState('NO_VIOLATION');
  const [findingSafe, setFindingSafe] = useState('');
  const [infoMsg, setInfoMsg] = useState('');

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setActErr(null);
    try { await fn(); reload(); onChanged(); } catch (e) { setActErr((e as Error).message); } finally { setBusy(false); }
  }, [reload, onChanged]);

  if (loading) return <Panel title="Case"><p className="adm-muted">Loading…</p></Panel>;
  if (error || !data) return <Panel title="Case"><p className="adm-error">{error ?? 'Not found.'}</p></Panel>;

  const d: EnfCaseDetail = data;
  const c = d.case;
  const nextStates = NEXT_STATUSES[c.status] ?? [];
  const appeal = d.appeals[0] ?? null;
  const appealPending = appeal && (appeal.status === 'SUBMITTED' || appeal.status === 'UNDER_REVIEW' || appeal.status === 'INFORMATION_REQUESTED');

  return (
    <Panel title={`Case ${c.publicRef}`}>
      {actErr ? <p className="adm-error">{actErr}</p> : null}
      <div className="adm-stats">
        <Stat label="Category" value={c.category.replace(/_/g, ' ').toLowerCase()} />
        <Stat label="Severity" value={<StatusPill status={c.severity} />} />
        <Stat label="Status" value={<StatusPill status={c.status} />} />
        <Stat label="Opened" value={when(Date.parse(c.openedAt))} />
      </div>

      <h4>Signals</h4>
      <MiniTable
        cols={['Source', 'Kind', 'Severity', 'When']}
        rows={d.signals.map((s) => [s.source.toLowerCase(), s.kind, <StatusPill key={s.id} status={s.severity} />, when(Date.parse(s.occurredAt))])}
        empty="No signals attached."
      />

      <h4>Evidence</h4>
      <MiniTable
        cols={['Type', 'Source', 'Visibility', 'When']}
        rows={d.evidence.map((e) => [e.type, e.source, e.visibility.toLowerCase(), when(Date.parse(e.capturedAt))])}
        empty="No evidence recorded."
      />

      <h4>Findings</h4>
      <MiniTable
        cols={['Reason', 'Adverse', 'Appealable', 'Status', 'When']}
        rows={d.findings.map((f) => [f.reasonCode, f.adverse ? 'yes' : 'no', f.appealable ? 'yes' : 'no', <StatusPill key={f.id} status={f.status} />, when(Date.parse(f.decidedAt))])}
        empty="No finding recorded yet — a case with no finding is not a violation."
      />

      <h4>Actions</h4>
      <MiniTable
        cols={['Action', 'Reason', 'By', 'When']}
        rows={d.actions.map((a) => [a.actionType, a.reasonCode ?? '—', a.performedBySystem ? 'system' : 'operator', when(Date.parse(a.performedAt))])}
        empty="No actions taken."
      />

      <h4>Holds</h4>
      <MiniTable
        cols={['Capability', 'Reason', 'Status', 'Placed']}
        rows={d.holds.map((h) => [<StatusPill key={h.id} status={h.capability} />, h.reasonCode, <StatusPill key={`${h.id}s`} status={h.status} />, when(Date.parse(h.createdAt))])}
        empty="No holds."
      />

      <h4>Information requests</h4>
      <MiniTable
        cols={['Type', 'Message', 'Status', 'Response']}
        rows={d.informationRequests.map((r) => [r.requestType, r.messageSafe, <StatusPill key={r.id} status={r.responseStatus} />, r.responseText ?? '—'])}
        empty="No information requested."
      />

      {appeal ? (
        <>
          <h4>Appeal</h4>
          <div className="adm-stats">
            <Stat label="Status" value={<StatusPill status={appeal.status} />} />
            <Stat label="Submitted" value={when(Date.parse(appeal.submittedAt))} />
          </div>
          {appeal.customerStatement ? <p className="adm-muted">Trader’s statement: {appeal.customerStatement}</p> : null}
          {d.appealDecisions.map((dec) => (
            <p key={dec.id} className="adm-muted">Decision: <strong>{dec.decision}</strong> — {dec.customerSafeExplanation ?? dec.rationaleInternal ?? ''} ({when(Date.parse(dec.decidedAt))})</p>
          ))}
        </>
      ) : null}

      <h4>Notes</h4>
      <MiniTable
        cols={['Visibility', 'Note', 'When']}
        rows={d.notes.map((n) => [n.visibility.toLowerCase(), n.body, when(Date.parse(n.createdAt))])}
        empty="No notes."
      />

      {!mayMutate ? (
        <p className="adm-muted">Read-only: investigating a case needs an operator role.</p>
      ) : (
        <div style={{ marginTop: 12 }}>
          {/* Transition */}
          {nextStates.length > 0 ? (
            <div className="adm-inline-actions">
              <span className="adm-muted">Move to:</span>
              {nextStates.map((to) => (
                <button
                  key={to}
                  className="adm-btn"
                  disabled={busy}
                  onClick={() => guard(() => adminApi.enfTransition(c.id, to, undefined, c.version))}
                  data-testid={`enf-transition-${to}`}
                >
                  {to.replace(/_/g, ' ').toLowerCase()}
                </button>
              ))}
            </div>
          ) : null}

          {/* Note */}
          <div className="adm-inline-actions" style={{ marginTop: 12 }}>
            <input className="adm-input" placeholder="Add an internal note" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 280 }} />
            <button className="adm-btn" disabled={busy || note.trim().length === 0} onClick={() => guard(async () => { await adminApi.enfNote(c.id, note.trim()); setNote(''); })}>Add note</button>
          </div>

          {/* Hold */}
          <div className="adm-inline-actions" style={{ marginTop: 12 }}>
            <span className="adm-muted">Place hold:</span>
            <select className="adm-input" value={holdCap} onChange={(e) => setHoldCap(e.target.value)}>
              {HOLD_CAPS.map((cap) => <option key={cap} value={cap}>{cap}</option>)}
            </select>
            <button
              className="adm-btn"
              disabled={busy || !c.subjectAccountId && (holdCap === 'TRADING' || holdCap.startsWith('PAYOUT'))}
              onClick={() => setConfirm({
                label: `Place ${holdCap} hold`,
                run: async () => {
                  const scope = holdCap === 'TRADING' || holdCap.startsWith('PAYOUT') ? (holdCap === 'TRADING' ? 'ACCOUNT' : 'PAYOUT') : 'CUSTOMER';
                  const scopeId = scope === 'CUSTOMER' ? c.customerIdentityId : (c.subjectAccountId ?? c.customerIdentityId);
                  await adminApi.enfPlaceHold(c.id, { scope, scopeId, capability: holdCap, reasonCode: `MANUAL_${holdCap}` });
                },
              })}
            >
              Hold…
            </button>
            <span className="adm-muted">A trading hold never blocks a closing/reducing order.</span>
          </div>

          {/* Information request */}
          <div className="adm-inline-actions" style={{ marginTop: 12 }}>
            <input className="adm-input" placeholder="Ask the trader for information (customer-safe)" value={infoMsg} onChange={(e) => setInfoMsg(e.target.value)} style={{ minWidth: 320 }} />
            <button className="adm-btn" disabled={busy || infoMsg.trim().length === 0} onClick={() => guard(async () => { await adminApi.enfInfoRequest(c.id, { requestType: 'GENERAL', messageSafe: infoMsg.trim() }); setInfoMsg(''); })}>Request info</button>
          </div>

          {/* Finding */}
          <div className="adm-inline-actions" style={{ marginTop: 12 }}>
            <span className="adm-muted">Record finding:</span>
            <select className="adm-input" value={findingCode} onChange={(e) => setFindingCode(e.target.value)} data-testid="enf-finding-code">
              <option value="NO_VIOLATION">NO_VIOLATION (clears the case)</option>
              {ADVERSE_FINDINGS.map((f) => <option key={f} value={f}>{f}{!maySuper ? ' (needs senior)' : ''}</option>)}
            </select>
            <input className="adm-input" placeholder="Customer-safe summary" value={findingSafe} onChange={(e) => setFindingSafe(e.target.value)} style={{ minWidth: 240 }} />
            <button
              className={`adm-btn ${findingCode !== 'NO_VIOLATION' ? 'adm-btn-danger' : 'adm-btn-primary'}`}
              disabled={busy || (findingCode !== 'NO_VIOLATION' && !maySuper)}
              onClick={() => setConfirm({
                label: findingCode === 'NO_VIOLATION' ? 'Record no violation' : `Confirm ${findingCode}`,
                run: async () => { await adminApi.enfFinding(c.id, { reasonCode: findingCode, summarySafe: findingSafe || undefined }); setFindingSafe(''); },
              })}
              data-testid="enf-record-finding"
            >
              Record finding
            </button>
            {findingCode !== 'NO_VIOLATION' && !maySuper ? <span className="adm-muted">A serious finding requires a senior operator.</span> : null}
          </div>

          {/* Safe containment actions */}
          <div className="adm-inline-actions" style={{ marginTop: 12 }}>
            <span className="adm-muted">Safety actions:</span>
            {SAFE_ACTIONS.map((a) => (
              <button key={a} className="adm-btn" disabled={busy} onClick={() => guard(() => adminApi.enfAction(c.id, { actionType: a }))} data-testid={`enf-action-${a}`}>
                {a.replace(/_/g, ' ').toLowerCase()}
              </button>
            ))}
          </div>

          {/* Punitive (SUPER_ADMIN only) */}
          {maySuper ? (
            <div className="adm-inline-actions" style={{ marginTop: 12 }}>
              <span className="adm-muted">Punitive (senior):</span>
              {PUNITIVE_ACTIONS.map((a) => (
                <button key={a} className="adm-btn adm-btn-danger" disabled={busy}
                  onClick={() => setConfirm({ label: a.replace(/_/g, ' ').toLowerCase(), run: () => adminApi.enfAction(c.id, { actionType: a }).then(() => undefined) })}>
                  {a.replace(/_/g, ' ').toLowerCase()}
                </button>
              ))}
            </div>
          ) : null}

          {/* Appeal decision */}
          {appealPending ? (
            <div className="adm-inline-actions" style={{ marginTop: 12 }}>
              <span className="adm-muted">Decide appeal:</span>
              {(['UPHELD', 'OVERTURNED', 'PARTIALLY_REMEDIATED'] as const).map((dec) => (
                <button key={dec} className="adm-btn" disabled={busy}
                  onClick={() => setConfirm({
                    label: `Appeal: ${dec.toLowerCase()}`,
                    run: async () => {
                      try {
                        await adminApi.enfDecideAppeal(appeal!.id, { decision: dec });
                      } catch (e) {
                        // Independence guard: same reviewer must be overridden by a senior.
                        if ((e as Error).message.includes('SAME_REVIEWER') && maySuper) {
                          await adminApi.enfDecideAppeal(appeal!.id, { decision: dec, overrideSameReviewer: true });
                        } else { throw e; }
                      }
                    },
                  })}>
                  {dec.replace(/_/g, ' ').toLowerCase()}
                </button>
              ))}
              <span className="adm-muted">An appeal can’t be decided by the same reviewer unless a senior overrides it.</span>
            </div>
          ) : null}
        </div>
      )}

      {confirm ? (
        <ConfirmAction
          title={confirm.label}
          description="This is recorded in the audit chain. Findings and holds are reversible; terminations and confirmed violations are serious — the trader keeps an appeal path where eligible."
          confirmLabel={confirm.label}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => { const run = confirm.run; setConfirm(null); void guard(() => run('')); }}
        />
      ) : null}
    </Panel>
  );
}

function MiniTable({ cols, rows, empty }: { cols: string[]; rows: React.ReactNode[][]; empty: string }): JSX.Element {
  return (
    <table className="adm-table">
      <thead><tr>{cols.map((col) => <th key={col}>{col}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className={j > 0 ? 'adm-dim' : ''}>{cell}</td>)}</tr>)}
        {rows.length === 0 ? <tr><td colSpan={cols.length} className="adm-muted">{empty}</td></tr> : null}
      </tbody>
    </table>
  );
}
