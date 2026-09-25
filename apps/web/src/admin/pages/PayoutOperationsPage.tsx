/**
 * The owner Payout Operations console (Milestone 8).
 *
 * Dense and operational, not flashy: the health of the straight-through payout
 * pipeline at a glance, the fast lane moving on its own, and the exceptions that
 * actually need a human. Every figure is a server read. Clean fast-lane payouts
 * need NO owner action; the owner acts only on exceptions, retries, reconciliation
 * and the treasury/circuit-breaker controls. PAID is never a button here — the
 * only manual paid path is an audited, SUPER_ADMIN break-glass with evidence.
 */
import { useCallback, useState, type JSX } from 'react';
import { adminApi, type PoOperation } from '../api';
import { ConfirmAction, Money, Panel, Stat, StatusPill, useLoad, when } from '../shared';

type Tab = 'OVERVIEW' | 'FAST_LANE' | 'EXCEPTIONS' | 'PROCESSING' | 'FAILED' | 'RECONCILIATION' | 'PROVIDER' | 'TREASURY';

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'OVERVIEW', label: 'Overview' },
  { key: 'FAST_LANE', label: 'Fast Lane' },
  { key: 'EXCEPTIONS', label: 'Exceptions' },
  { key: 'PROCESSING', label: 'Processing' },
  { key: 'FAILED', label: 'Failed / Returned' },
  { key: 'RECONCILIATION', label: 'Reconciliation' },
  { key: 'PROVIDER', label: 'Provider Health' },
  { key: 'TREASURY', label: 'Treasury Controls' },
];

const ms = (v: number | null): string => (v == null ? '—' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}s`);
const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

export function AdminPayoutOperationsPage({ mayMutate, maySuper }: { mayMutate: boolean; maySuper: boolean }): JSX.Element {
  const [tab, setTab] = useState<Tab>('OVERVIEW');
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="adm-page">
      <Panel
        title="Payout Operations"
        action={
          <div className="adm-tabs" role="tablist" aria-label="Payout ops view">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key}
                className={`adm-tab ${tab === t.key ? 'adm-tab-on' : ''}`}
                data-testid={`po-tab-${t.key.toLowerCase()}`}
                onClick={() => { setTab(t.key); setOpenId(null); }}>
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        <p className="adm-muted">
          Clean, eligible payouts process automatically — target request → provider-submission under
          five minutes — with no routine human approval. This is Happy Trader’s processing time, not a
          guarantee of bank settlement. Only exceptions need a human.
        </p>
      </Panel>

      {tab === 'OVERVIEW' ? <Overview /> : null}
      {tab === 'FAST_LANE' ? <OpsTable state="PAYABLE,SUBMITTING,SUBMITTED,PROCESSING" title="Fast lane" onOpen={setOpenId} openId={openId} /> : null}
      {tab === 'EXCEPTIONS' ? <OpsTable state="EXCEPTION" title="Exceptions" onOpen={setOpenId} openId={openId} /> : null}
      {tab === 'PROCESSING' ? <OpsTable state="PROCESSING,SUBMITTED" title="Processing" onOpen={setOpenId} openId={openId} /> : null}
      {tab === 'FAILED' ? <OpsTable state="FAILED,RETURNED" title="Failed / Returned" onOpen={setOpenId} openId={openId} /> : null}
      {tab === 'RECONCILIATION' ? <OpsTable state="PAID,RECONCILED,PROCESSING" title="Reconciliation" onOpen={setOpenId} openId={openId} /> : null}
      {tab === 'PROVIDER' ? <ProviderHealth /> : null}
      {tab === 'TREASURY' ? <Treasury mayMutate={mayMutate} /> : null}

      {openId ? <OpDetail id={openId} mayMutate={mayMutate} maySuper={maySuper} /> : null}
    </div>
  );
}

function Overview(): JSX.Element {
  const { data, error, loading } = useLoad(() => adminApi.poOverview(), []);
  if (loading) return <Panel title="Overview"><p className="adm-muted">Loading…</p></Panel>;
  if (error || !data) return <Panel title="Overview"><p className="adm-error">{error ?? 'No data.'}</p></Panel>;
  const o = data;
  return (
    <>
      <Panel title="Today">
        <div className="adm-stats">
          <Stat label="Requested" value={o.requestedToday} sub={<Money micros={o.dollarsRequestedMicros} />} />
          <Stat label="Submitted" value={o.submittedToday} sub={<Money micros={o.dollarsSubmittedMicros} />} />
          <Stat label="Paid" value={o.paidToday} sub={<Money micros={o.dollarsPaidMicros} />} />
          <Stat label="Fast-lane rate" value={pct(o.fastLaneRate)} />
          <Stat label="Exception rate" value={pct(o.exceptionRate)} />
          <Stat label="Provider failure" value={pct(o.providerFailureRate)} />
        </div>
      </Panel>
      <Panel title="Speed (request → provider submitted)">
        <div className="adm-stats">
          <Stat label="Median" value={ms(o.medianRequestToSubmissionMs)} />
          <Stat label="P90" value={ms(o.p90RequestToSubmissionMs)} />
          <Stat label="P95 (target < 5m)" value={ms(o.p95RequestToSubmissionMs)} />
          <Stat label="P99" value={ms(o.p99RequestToSubmissionMs)} />
          <Stat label="> 5 minutes" value={o.overFiveMinuteCount} />
        </div>
        {o.overFiveMinuteCount > 0 ? <p className="adm-error" data-testid="po-sla-breach">{o.overFiveMinuteCount} clean payout(s) breached the 5-minute submission target.</p> : <p className="adm-muted">No SLA breaches.</p>}
      </Panel>
      <Panel title="Health">
        <div className="adm-stats">
          <Stat label="Exceptions" value={o.exceptionCount} />
          <Stat label="Failed" value={o.failedCount} />
          <Stat label="Returned" value={o.returnedCount} />
          <Stat label="Recon mismatches" value={o.reconciliationMismatchCount} />
          <Stat label="Provider" value={<><StatusPill status={o.provider.state} /> {o.provider.id}</>} />
          <Stat label="Circuit breaker" value={<StatusPill status={o.circuitBreakerOpen ? 'OPEN' : 'CLOSED'} />} />
        </div>
      </Panel>
    </>
  );
}

function OpsTable({ state, title, onOpen, openId }: { state: string; title: string; onOpen: (id: string) => void; openId: string | null }): JSX.Element {
  const { data, error, loading } = useLoad(() => adminApi.poOperations(state), [state]);
  const rows = data?.operations ?? [];
  if (loading) return <Panel title={title}><p className="adm-muted">Loading…</p></Panel>;
  if (error) return <Panel title={title}><p className="adm-error">{error}</p></Panel>;
  return (
    <Panel title={title}>
      <table className="adm-table" data-testid={`po-table-${title.replace(/\W+/g, '-').toLowerCase()}`}>
        <thead>
          <tr>
            <th>Trader</th><th>Account</th><th className="num">Gross</th><th className="num">Trader share</th>
            <th>Provider</th><th>State</th><th>Fast lane</th><th className="num">Req→Submit</th><th>SLA</th><th className="adm-actions-col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r: PoOperation) => (
            <tr key={r.payoutRequestId} data-testid={`po-op-${r.payoutRequestId}`}>
              <td className="adm-dim">{r.traderEmail ?? '—'}</td>
              <td className="adm-dim">{r.accountPublicId ?? '—'}</td>
              <td className="num"><Money micros={r.requestedGrossMicros} /></td>
              <td className="num">{r.traderShareMicros != null ? <Money micros={r.traderShareMicros} /> : '—'}</td>
              <td className="adm-dim">{r.provider ?? '—'}</td>
              <td><StatusPill status={r.opState} />{r.exceptionCategory ? <span className="adm-dim"> {r.exceptionCategory.replace(/_/g, ' ').toLowerCase()}</span> : null}</td>
              <td>{r.fastLane ? '✓' : '—'}</td>
              <td className="num">{ms(r.requestToSubmissionMs)}</td>
              <td>{r.slaBreached ? <span className="adm-pill adm-status-failed">breach</span> : '—'}</td>
              <td className="adm-actions-col"><button className="adm-btn" onClick={() => onOpen(openId === r.payoutRequestId ? '' : r.payoutRequestId)}>{openId === r.payoutRequestId ? 'Hide' : 'Open'}</button></td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={10} className="adm-muted">Nothing here.</td></tr> : null}
        </tbody>
      </table>
    </Panel>
  );
}

function ProviderHealth(): JSX.Element {
  const { data, error, loading } = useLoad(() => adminApi.poConfig(), []);
  if (loading) return <Panel title="Provider Health"><p className="adm-muted">Loading…</p></Panel>;
  if (error || !data) return <Panel title="Provider Health"><p className="adm-error">{error ?? 'No data.'}</p></Panel>;
  const h = data.providerHealth;
  return (
    <Panel title="Provider Health">
      <div className="adm-stats">
        <Stat label="Provider" value={h.id} />
        <Stat label="Configured" value={h.configured ? 'yes' : 'no'} />
        <Stat label="State" value={<StatusPill status={h.state} />} />
        <Stat label="Mode" value={h.isMock ? 'mock (dev/test)' : 'production'} />
        <Stat label="Production enabled" value={data.config.productionEnabled ? 'yes' : 'no'} />
      </div>
      {!h.configured ? <p className="adm-muted" data-testid="po-provider-unconfigured">No payout provider is configured. Production payouts are disabled and fail closed until a provider is set up.</p> : null}
    </Panel>
  );
}

function Treasury({ mayMutate }: { mayMutate: boolean }): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => adminApi.poConfig(), []);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: 'OPEN' | 'CLOSE' } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const toggleBreaker = useCallback(async (action: 'OPEN' | 'CLOSE', reason: string) => {
    setBusy(true); setMsg(null);
    try { await adminApi.poCircuitBreaker(action, reason); setConfirm(null); reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }, [reload]);

  if (loading) return <Panel title="Treasury Controls"><p className="adm-muted">Loading…</p></Panel>;
  if (error || !data) return <Panel title="Treasury Controls"><p className="adm-error">{error ?? 'No data.'}</p></Panel>;
  const c = data.config;
  return (
    <Panel title="Treasury Controls">
      {msg ? <p className="adm-error">{msg}</p> : null}
      <p className="adm-muted">
        Operational controls, never trader eligibility. Opening the circuit breaker pauses new external
        submissions; it never deletes requests, erases liabilities, rewrites paid history, or makes
        anyone ineligible. Production payouts stay disabled until explicitly enabled.
      </p>
      <div className="adm-stats">
        <Stat label="Production" value={c.productionEnabled ? 'ENABLED' : 'disabled'} />
        <Stat label="Provider" value={c.provider ?? 'unconfigured'} />
        <Stat label="Circuit breaker" value={<StatusPill status={c.circuitBreakerOpen ? 'OPEN' : 'CLOSED'} />} />
        <Stat label="Max single auto" value={c.maxSingleAutoMicros != null ? <Money micros={c.maxSingleAutoMicros} /> : 'none'} />
        <Stat label="Max daily auto" value={c.maxAggregateAutoPerDayMicros != null ? <Money micros={c.maxAggregateAutoPerDayMicros} /> : 'none'} />
        <Stat label="Recon stale" value={`${c.reconStaleThresholdSeconds}s`} />
      </div>
      {mayMutate ? (
        <div className="adm-inline-actions" style={{ marginTop: 12 }}>
          {c.circuitBreakerOpen
            ? <button className="adm-btn adm-btn-primary" data-testid="po-breaker-close" disabled={busy} onClick={() => setConfirm({ action: 'CLOSE' })}>Close breaker (resume)</button>
            : <button className="adm-btn adm-btn-danger" data-testid="po-breaker-open" disabled={busy} onClick={() => setConfirm({ action: 'OPEN' })}>Open breaker (pause submissions)</button>}
        </div>
      ) : <p className="adm-muted">Read-only: changing treasury controls needs an operator role.</p>}
      {confirm ? (
        <ConfirmAction
          title={confirm.action === 'OPEN' ? 'Open circuit breaker' : 'Close circuit breaker'}
          description="This pauses or resumes external payout submissions. Liabilities and paid history are untouched; no trader becomes ineligible."
          confirmLabel={confirm.action === 'OPEN' ? 'Open breaker' : 'Close breaker'}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => toggleBreaker(confirm.action, reason)}
        />
      ) : null}
    </Panel>
  );
}

function OpDetail({ id, mayMutate, maySuper }: { id: string; mayMutate: boolean; maySuper: boolean }): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => adminApi.poOperation(id), [id]);
  const [busy, setBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [breakGlass, setBreakGlass] = useState(false);
  const [ref, setRef] = useState('');
  const [reason, setReason] = useState('');

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setActErr(null);
    try { await fn(); reload(); } catch (e) { setActErr((e as Error).message); } finally { setBusy(false); }
  }, [reload]);

  if (loading) return <Panel title="Payout operation"><p className="adm-muted">Loading…</p></Panel>;
  if (error || !data) return <Panel title="Payout operation"><p className="adm-error">{error ?? 'Not found.'}</p></Panel>;
  const d = data;
  const req = d.request as { requestedGrossMicros?: number; traderShareMicros?: number } | null;

  return (
    <Panel title="Payout operation">
      {actErr ? <p className="adm-error">{actErr}</p> : null}
      <div className="adm-stats">
        <Stat label="State" value={<StatusPill status={d.operation.opState} />} />
        <Stat label="Exception" value={d.operation.exceptionCategory ? d.operation.exceptionCategory.replace(/_/g, ' ').toLowerCase() : '—'} />
        <Stat label="Fast lane" value={d.operation.fastLane ? '✓' : '—'} />
        <Stat label="Provider payout" value={d.operation.providerPayoutId ?? '—'} />
        <Stat label="Gross" value={req?.requestedGrossMicros != null ? <Money micros={req.requestedGrossMicros} /> : '—'} />
        <Stat label="Trader share" value={req?.traderShareMicros != null ? <Money micros={req.traderShareMicros} /> : '—'} />
      </div>

      <h4>Timeline</h4>
      <ul className="adm-timeline">
        {d.timeline.map((t, i) => <li key={i}><span className="adm-dim">{when(Date.parse(t.at))}</span> — {t.label}</li>)}
        {d.timeline.length === 0 ? <li className="adm-muted">No events yet.</li> : null}
      </ul>

      <h4>Speed</h4>
      <div className="adm-stats">
        <Stat label="Req→Approval" value={ms(d.timings.requestToApprovalMs)} />
        <Stat label="Req→Submission" value={ms(d.timings.requestToSubmissionMs)} />
        <Stat label="Submit→Ack" value={ms(d.timings.submissionToAckMs)} />
        <Stat label="Submit→Paid" value={ms(d.timings.submissionToPaidMs)} />
      </div>

      <h4>Operational checks</h4>
      <table className="adm-table"><thead><tr><th>Check</th><th>Result</th><th>Category</th><th>When</th></tr></thead>
        <tbody>{d.checks.map((c) => <tr key={c.id}><td>{c.checkType}</td><td><StatusPill status={c.result} /></td><td className="adm-dim">{c.category ?? '—'}</td><td className="adm-dim">{when(Date.parse(c.createdAt))}</td></tr>)}
          {d.checks.length === 0 ? <tr><td colSpan={4} className="adm-muted">None.</td></tr> : null}</tbody></table>

      <h4>Submission attempts</h4>
      <table className="adm-table"><thead><tr><th>#</th><th>Provider</th><th>Result</th><th>Error</th><th>Retryable</th><th>Provider payout</th></tr></thead>
        <tbody>{d.attempts.map((a) => <tr key={a.id}><td>{a.attemptNumber}</td><td className="adm-dim">{a.provider}</td><td>{a.normalizedResult ?? '—'}</td><td className="adm-dim">{a.errorCategory ?? '—'}</td><td>{a.retryable ? 'yes' : 'no'}</td><td className="adm-dim">{a.providerPayoutId ?? '—'}</td></tr>)}
          {d.attempts.length === 0 ? <tr><td colSpan={6} className="adm-muted">None.</td></tr> : null}</tbody></table>

      <h4>Provider events</h4>
      <table className="adm-table"><thead><tr><th>Event</th><th>Type</th><th>Processing</th><th>Received</th></tr></thead>
        <tbody>{d.providerEvents.map((e) => <tr key={e.id}><td className="adm-dim">{e.providerEventId}</td><td>{e.normalizedType}</td><td className="adm-dim">{e.processingState}</td><td className="adm-dim">{when(Date.parse(e.receivedAt))}</td></tr>)}
          {d.providerEvents.length === 0 ? <tr><td colSpan={4} className="adm-muted">None.</td></tr> : null}</tbody></table>

      <h4>Reconciliation</h4>
      <table className="adm-table"><thead><tr><th>Mismatch</th><th>Resolution</th><th>Auto</th><th>When</th></tr></thead>
        <tbody>{d.reconciliation.map((r) => <tr key={r.id}><td>{r.mismatchType}</td><td className="adm-dim">{r.resolution}</td><td>{r.autoResolved ? 'yes' : 'no'}</td><td className="adm-dim">{when(Date.parse(r.createdAt))}</td></tr>)}
          {d.reconciliation.length === 0 ? <tr><td colSpan={4} className="adm-muted">None.</td></tr> : null}</tbody></table>

      {mayMutate ? (
        <div className="adm-inline-actions" style={{ marginTop: 12 }}>
          <button className="adm-btn" data-testid="po-retry" disabled={busy} onClick={() => run(() => adminApi.poRetry(id))}>Retry submission</button>
          <button className="adm-btn" data-testid="po-reconcile" disabled={busy} onClick={() => run(() => adminApi.poReconcile(id))}>Reconcile now</button>
          {maySuper ? <button className="adm-btn adm-btn-danger" disabled={busy} onClick={() => setBreakGlass((v) => !v)}>Break-glass manual paid…</button> : null}
        </div>
      ) : null}

      {breakGlass && maySuper ? (
        <div style={{ marginTop: 8 }}>
          <p className="adm-muted">A manual PAID requires external evidence and is fully audited. It is never a casual button.</p>
          <div className="adm-inline-actions">
            <input className="adm-input" placeholder="External payment reference" value={ref} onChange={(e) => setRef(e.target.value)} />
            <input className="adm-input" placeholder="Reason (≥10 chars)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} />
            <button className="adm-btn adm-btn-danger" disabled={busy || ref.trim().length < 3 || reason.trim().length < 10}
              onClick={() => run(async () => { await adminApi.poManualResolution(id, { resolution: 'MARK_PAID', reason: reason.trim(), externalReference: ref.trim(), amountMicros: req?.traderShareMicros ?? 0 }); setBreakGlass(false); })}>
              Record manual paid
            </button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
