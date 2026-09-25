/**
 * Owner OS — Affiliate program surfaces (M11-I).
 *
 * Overview + Applications review + Affiliate directory (AffiliatesPage), and the
 * full internal Affiliate 360 (Affiliate360Page). Every figure comes from the
 * server (/api/v1/admin/ops/affiliates/*); nothing is computed here. Owner-tier
 * money actions (rate change, tier override, commission adjustment, marking a
 * payout paid, program config) require a FINANCIAL step-up, collected inline and
 * sent as the x-stepup-token header — the same reauth the server enforces.
 */
import { useCallback, useState, type JSX, type ReactNode } from 'react';
import { api, request } from '../../api/client';
import { formatMicros, formatCompactMicros } from '../../state/format';
import { Panel, Stat, Money, StatusPill, useLoad } from '../shared';
import type { AdminRouteGo } from '../shared';

const OPS = '/api/v1/admin/ops';

interface Overview {
  activeAffiliates: number; pendingApplications: number; approvedAwaitingAgreement: number; suspended: number;
  byStatus: Record<string, number>; applicationsByStatus: Record<string, number>;
  referredRevenueMtdMicros: number; commissionAccruedMicros: number; commissionPayableMicros: number;
  commissionPaidMicros: number; commissionReversedMicros: number; affiliatePayoutLiabilityMicros: number;
}
type Row = Record<string, unknown>;

const affOps = {
  overview: () => api.get<Overview>(`${OPS}/affiliates/overview`),
  applications: (status?: string) => api.get<{ applications: Row[] }>(`${OPS}/affiliates/applications${status ? `?status=${status}` : ''}`),
  affiliates: (q: { status?: string; q?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.q) p.set('q', q.q);
    return api.get<{ affiliates: Row[] }>(`${OPS}/affiliates?${p.toString()}`);
  },
  detail: (id: string) => api.get<Row & { found?: false }>(`${OPS}/affiliates/${id}`),
  config: () => api.get<{ version: number; settings: Record<string, unknown> }>(`${OPS}/affiliates/config`),
  review: (id: string, decision: string, extra: Record<string, unknown> = {}) =>
    api.post<{ ok: boolean }>(`${OPS}/affiliates/${id}/review`, { decision, ...extra }),
  status: (id: string, status: string, reason: string) =>
    api.post<{ ok: boolean }>(`${OPS}/affiliates/${id}/status`, { status, reason }),
  payoutAction: (payoutId: string, action: 'approve' | 'cancel' | 'fail', body: Record<string, unknown> = {}) =>
    api.post<{ ok: boolean }>(`${OPS}/affiliates/payouts/${payoutId}/${action}`, body),
  runMature: () => api.post<{ matured: number }>(`${OPS}/affiliates/jobs/mature`, {}),
  runRecalc: () => api.post<{ changed: number }>(`${OPS}/affiliates/jobs/recalc-tiers`, {}),
  // Step-up (FINANCIAL) actions.
  rate: (id: string, body: Record<string, unknown>, token: string) => stepUpPost(`${OPS}/affiliates/${id}/rate`, body, token),
  tier: (id: string, body: Record<string, unknown>, token: string) => stepUpPost(`${OPS}/affiliates/${id}/tier`, body, token),
  adjust: (id: string, body: Record<string, unknown>, token: string) => stepUpPost(`${OPS}/affiliates/${id}/adjust`, body, token),
  pay: (payoutId: string, body: Record<string, unknown>, token: string) => stepUpPost(`${OPS}/affiliates/payouts/${payoutId}/pay`, body, token),
};

function stepUpPost(path: string, body: Record<string, unknown>, token: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(path, { method: 'POST', body: JSON.stringify(body), headers: { 'x-stepup-token': token } });
}
async function mintStepUp(password: string, cls: string): Promise<string> {
  const r = await api.post<{ token: string }>('/api/v1/admin/security/reauth', { password, class: cls });
  return r.token;
}

function pct(bps: number | null | undefined): string {
  if (bps == null) return '—';
  const p = bps / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}
function whenD(v: unknown): string { return v ? new Date(String(v)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' }) : '—'; }

// ---------------------------------------------------------------------------
// Overview + Applications + Directory
// ---------------------------------------------------------------------------
export function AffiliatesPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const ov = useLoad(affOps.overview, []);
  return (
    <div className="adm-page" data-testid="affiliates-page">
      <div className="adm-page-head"><h1>Affiliates</h1><div className="adm-spacer" /><button className="adm-btn" onClick={ov.reload}>Refresh</button></div>
      {ov.error ? <p className="adm-error">{ov.error}</p> : null}
      {ov.data ? (
        <Panel title="Program overview">
          <div className="adm-stat-grid">
            <Stat label="Active affiliates" value={ov.data.activeAffiliates} />
            <Stat label="Pending applications" value={ov.data.pendingApplications} />
            <Stat label="Approved, awaiting agreement" value={ov.data.approvedAwaitingAgreement} />
            <Stat label="Suspended" value={ov.data.suspended} />
            <Stat label="Referred revenue (MTD)" value={<Money micros={ov.data.referredRevenueMtdMicros} />} />
            <Stat label="Commission accrued" value={<Money micros={ov.data.commissionAccruedMicros} />} />
            <Stat label="Commission payable" value={<Money micros={ov.data.commissionPayableMicros} />} />
            <Stat label="Commission paid" value={<Money micros={ov.data.commissionPaidMicros} />} />
            <Stat label="Commission reversed" value={<Money micros={ov.data.commissionReversedMicros} />} />
            <Stat label="Payout liability" value={<Money micros={ov.data.affiliatePayoutLiabilityMicros} />} />
          </div>
        </Panel>
      ) : <p className="adm-muted">Loading…</p>}

      <ApplicationsPanel />
      <DirectoryPanel go={go} />
      <ConfigPanel />
      <JobsPanel />
    </div>
  );
}

function ApplicationsPanel(): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => affOps.applications(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function act(id: string, decision: 'APPROVE' | 'DECLINE' | 'REQUEST_INFO'): Promise<void> {
    let extra: Record<string, unknown> = {};
    if (decision === 'DECLINE') {
      const reason = window.prompt('Reason for declining (recorded):') ?? '';
      if (!reason.trim()) return;
      extra = { declineReason: reason.trim() };
    } else if (decision === 'REQUEST_INFO') {
      const notes = window.prompt('What information do you need?') ?? '';
      if (!notes.trim()) return;
      extra = { notes: notes.trim() };
    }
    setBusy(id); setMsg(null);
    try { await affOps.review(id, decision, extra); setMsg(`Application ${decision.toLowerCase()}d.`); reload(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(null); }
  }

  const pending = (data?.applications ?? []).filter((a) => ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED'].includes(String(a['status'])));
  return (
    <Panel title="Applications" action={<button className="adm-btn" onClick={reload}>Refresh</button>}>
      {loading ? <p className="adm-muted">Loading…</p> : null}
      {error ? <p className="adm-error">{error}</p> : null}
      {msg ? <p className="adm-muted">{msg}</p> : null}
      {data && pending.length === 0 ? <p className="adm-muted">No applications awaiting review.</p> : null}
      {pending.length > 0 ? (
        <table className="adm-table">
          <thead><tr><th>Submitted</th><th>Name</th><th>Email</th><th>Platform</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {pending.map((a) => {
              const id = String(a['affiliateId']);
              return (
                <tr key={String(a['id'])}>
                  <td className="adm-muted">{whenD(a['submittedAt'])}</td>
                  <td>{String(a['fullName'] ?? '—')}</td>
                  <td className="adm-muted">{String(a['email'] ?? '—')}</td>
                  <td>{String(a['primaryPlatform'] ?? '—')}</td>
                  <td><StatusPill status={String(a['status'])} /></td>
                  <td>
                    <button className="adm-btn" disabled={busy === id} onClick={() => act(id, 'APPROVE')}>Approve</button>{' '}
                    <button className="adm-btn" disabled={busy === id} onClick={() => act(id, 'REQUEST_INFO')}>Request info</button>{' '}
                    <button className="adm-btn adm-btn-danger" disabled={busy === id} onClick={() => act(id, 'DECLINE')}>Decline</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <p className="adm-muted" style={{ marginTop: 10 }}>Approval does not activate an affiliate. A code and link go live only after they accept the partner agreement.</p>
    </Panel>
  );
}

function DirectoryPanel({ go }: { go: AdminRouteGo }): JSX.Element {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const { data, error, loading } = useLoad(() => affOps.affiliates({ q: q.length >= 2 ? q : undefined, status: status || undefined }), [q, status]);
  return (
    <Panel title="Affiliate directory" action={
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="adm-input" placeholder="Search name / email / id" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="adm-input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['ACTIVE', 'APPROVED_PENDING_AGREEMENT', 'PAUSED', 'SUSPENDED', 'TERMINATED', 'SUBMITTED', 'UNDER_REVIEW', 'DECLINED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    }>
      {loading ? <p className="adm-muted">Loading…</p> : null}
      {error ? <p className="adm-error">{error}</p> : null}
      {data && data.affiliates.length === 0 ? <p className="adm-muted">No affiliates match.</p> : null}
      {data && data.affiliates.length > 0 ? (
        <table className="adm-table">
          <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Status</th><th>Tier</th><th className="num">Rate</th><th>Joined</th></tr></thead>
          <tbody>
            {data.affiliates.map((a) => (
              <tr key={String(a['id'])} style={{ cursor: 'pointer' }} onClick={() => go({ name: 'AFFILIATE', id: String(a['id']) } as never)}>
                <td><button className="adm-link">{String(a['publicId'])}</button></td>
                <td>{String(a['displayName'])}</td>
                <td className="adm-muted">{String(a['email'] ?? '—')}</td>
                <td><StatusPill status={String(a['status'])} /></td>
                <td>{String(a['tier'])}</td>
                <td className="num">{pct(Number(a['effectiveRateBps']))}</td>
                <td className="adm-muted">{whenD(a['createdAt'])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}

function ConfigPanel(): JSX.Element {
  const { data, error } = useLoad(affOps.config, []);
  return (
    <Panel title="Program configuration">
      {error ? <p className="adm-error">{error}</p> : null}
      {data ? (
        <>
          <p className="adm-muted">Version {data.version}. Rates and thresholds are configuration, not code. Editing requires a FINANCIAL step-up (use the API; changes are versioned and audited).</p>
          <table className="adm-table">
            <tbody>
              {Object.entries(data.settings).map(([k, v]) => (
                <tr key={k}><td className="adm-muted">{k}</td><td><code>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</code></td></tr>
              ))}
            </tbody>
          </table>
        </>
      ) : <p className="adm-muted">Loading…</p>}
    </Panel>
  );
}

function JobsPanel(): JSX.Element {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(which: 'mature' | 'recalc'): Promise<void> {
    setBusy(true); setMsg(null);
    try {
      if (which === 'mature') { const r = await affOps.runMature(); setMsg(`Matured ${r.matured} commission(s).`); }
      else { const r = await affOps.runRecalc(); setMsg(`Re-tiered ${r.changed} affiliate(s).`); }
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Panel title="Maintenance jobs">
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="adm-btn" disabled={busy} onClick={() => run('mature')}>Run commission maturity</button>
        <button className="adm-btn" disabled={busy} onClick={() => run('recalc')}>Recalculate tiers</button>
      </div>
      {msg ? <p className="adm-muted" style={{ marginTop: 10 }}>{msg}</p> : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Affiliate 360
// ---------------------------------------------------------------------------
export function Affiliate360Page({ id, go }: { id: string; go: AdminRouteGo }): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => affOps.detail(id), [id]);
  if (loading) return <div className="adm-page"><p className="adm-muted">Loading…</p></div>;
  if (error) return <div className="adm-page"><p className="adm-error">{error}</p></div>;
  if (!data || data.found === false) return <div className="adm-page"><p className="adm-error">Affiliate not found.</p></div>;

  const aff = data['affiliate'] as Row;
  const balance = data['balance'] as Record<string, number>;
  const codes = (data['codes'] as Row[]) ?? [];
  const conversions = (data['recentConversions'] as Row[]) ?? [];
  const commissions = (data['recentCommissions'] as Row[]) ?? [];
  const payouts = (data['payouts'] as Row[]) ?? [];
  const rateHistory = (data['rateHistory'] as Row[]) ?? [];
  const tierHistory = (data['tierHistory'] as Row[]) ?? [];
  const riskSignals = (data['riskSignals'] as Row[]) ?? [];

  return (
    <div className="adm-page" data-testid="affiliate-360">
      <div className="adm-page-head">
        <button className="adm-link" onClick={() => go({ name: 'AFFILIATES' } as never)}>← Affiliates</button>
        <h1 style={{ marginLeft: 12 }}>{String(aff['displayName'])} <span className="adm-muted">({String(aff['publicId'])})</span></h1>
        <div className="adm-spacer" />
        <StatusPill status={String(aff['status'])} />
        <button className="adm-btn" onClick={reload}>Refresh</button>
      </div>

      <Panel title="Snapshot">
        <div className="adm-stat-grid">
          <Stat label="Status" value={String(aff['status'])} />
          <Stat label="Tier" value={String(aff['tier'])} />
          <Stat label="Effective rate" value={pct(Number(aff['effectiveRateBps']))} sub={aff['customRateBps'] != null ? 'custom override' : 'tier rate'} />
          <Stat label="Email" value={<span className="adm-muted">{String(aff['email'] ?? '—')}</span>} />
          <Stat label="Withdrawable" value={<Money micros={balance?.withdrawableMicros ?? 0} />} />
          <Stat label="Available" value={<Money micros={balance?.availableMicros ?? 0} />} />
          <Stat label="Pending" value={<Money micros={balance?.pendingMicros ?? 0} />} />
          <Stat label="Lifetime paid" value={<Money micros={balance?.lifetimePaidMicros ?? 0} />} />
          <Stat label="Reversed" value={<Money micros={balance?.reversalMicros ?? 0} />} />
        </div>
      </Panel>

      <AffiliateActions id={id} status={String(aff['status'])} onDone={reload} />

      <Panel title="Codes">
        {codes.length === 0 ? <p className="adm-muted">No codes.</p> : (
          <table className="adm-table"><thead><tr><th>Code</th><th>Type</th><th>Campaign</th><th>Discount</th><th>Status</th></tr></thead>
            <tbody>{codes.map((c) => (<tr key={String(c['id'])}><td><code>{String(c['code'])}</code></td><td>{String(c['kind']).toLowerCase()}</td><td>{String(c['campaignLabel'] ?? '—')}</td><td>{c['discountBps'] ? pct(Number(c['discountBps'])) : '—'}</td><td>{String(c['status']).toLowerCase()}</td></tr>))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title="Recent conversions">
        {conversions.length === 0 ? <p className="adm-muted">No conversions.</p> : (
          <table className="adm-table"><thead><tr><th>Date</th><th>Order</th><th>Source</th><th className="num">Qualified</th></tr></thead>
            <tbody>{conversions.map((c) => (<tr key={String(c['id'])}><td className="adm-muted">{whenD(c['createdAt'])}</td><td className="adm-muted">{String(c['commercialOrderId'] ?? '—').slice(0, 8)}</td><td>{String(c['source'] ?? '').toLowerCase()}</td><td className="num">{formatMicros(Number(c['qualifiedRevenueMicros'] ?? 0))}</td></tr>))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title="Recent commissions">
        {commissions.length === 0 ? <p className="adm-muted">No commissions.</p> : (
          <table className="adm-table"><thead><tr><th>Date</th><th className="num">Rate</th><th className="num">Commission</th><th>Status</th><th>Matures</th></tr></thead>
            <tbody>{commissions.map((c) => (<tr key={String(c['id'])}><td className="adm-muted">{whenD(c['createdAt'])}</td><td className="num">{pct(Number(c['rateBps']))}</td><td className="num">{formatMicros(Number(c['commissionMicros'] ?? 0))}</td><td><StatusPill status={String(c['status'])} /></td><td className="adm-muted">{whenD(c['maturityAt'])}</td></tr>))}</tbody>
          </table>
        )}
      </Panel>

      <PayoutsAdminPanel payouts={payouts} onDone={reload} />

      <Panel title="Rate history">
        {rateHistory.length === 0 ? <p className="adm-muted">No rate changes.</p> : (
          <table className="adm-table"><thead><tr><th>When</th><th className="num">From</th><th className="num">To</th><th>Source</th><th>Reason</th></tr></thead>
            <tbody>{rateHistory.map((h) => (<tr key={String(h['id'])}><td className="adm-muted">{whenD(h['createdAt'])}</td><td className="num">{pct(h['fromRateBps'] as number | null)}</td><td className="num">{pct(h['toRateBps'] as number | null)}</td><td>{String(h['rateSource'] ?? h['source'] ?? '—')}</td><td className="adm-muted">{String(h['reason'] ?? '—')}</td></tr>))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title="Tier history">
        {tierHistory.length === 0 ? <p className="adm-muted">No tier changes.</p> : (
          <table className="adm-table"><thead><tr><th>When</th><th>From</th><th>To</th><th>Reason</th></tr></thead>
            <tbody>{tierHistory.map((h) => (<tr key={String(h['id'])}><td className="adm-muted">{whenD(h['createdAt'])}</td><td>{String(h['fromTier'] ?? '—')}</td><td>{String(h['toTier'] ?? '—')}</td><td className="adm-muted">{String(h['reason'] ?? '—')}</td></tr>))}</tbody>
          </table>
        )}
      </Panel>

      <Panel title="Risk signals">
        {riskSignals.length === 0 ? <p className="adm-muted">No risk signals.</p> : (
          <table className="adm-table"><thead><tr><th>When</th><th>Type</th><th>Severity</th><th>Detail</th></tr></thead>
            <tbody>{riskSignals.map((r) => (<tr key={String(r['id'])}><td className="adm-muted">{whenD(r['createdAt'])}</td><td>{String(r['signalType'] ?? r['type'] ?? '—')}</td><td><StatusPill status={String(r['severity'] ?? 'INFO')} /></td><td className="adm-muted">{String(r['detail'] ?? r['explanation'] ?? '—')}</td></tr>))}</tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function AffiliateActions({ id, status, onDone }: { id: string; status: string; onDone: () => void }): JSX.Element {
  const [msg, setMsg] = useState<string | null>(null);
  const notify = useCallback((s: string) => { setMsg(s); onDone(); }, [onDone]);

  return (
    <Panel title="Actions">
      {msg ? <p className="adm-muted">{msg}</p> : null}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <StatusAction id={id} status={status} onMsg={notify} />
        <StepUpForm
          title="Change commission rate" cls="FINANCIAL" confirmLabel="Apply rate"
          fields={[{ key: 'customRateBps', label: 'Custom rate (bps, blank = clear override)', kind: 'number' }, { key: 'reason', label: 'Reason', kind: 'text', required: true }]}
          onSubmit={async (vals, token) => {
            const raw = String(vals['customRateBps'] ?? '').trim();
            await affOps.rate(id, { customRateBps: raw === '' ? null : Number(raw), reason: String(vals['reason']) }, token);
            notify('Rate updated.');
          }}
        />
        <StepUpForm
          title="Set tier (manual)" cls="FINANCIAL" confirmLabel="Set tier"
          fields={[{ key: 'tier', label: 'Tier', kind: 'select', options: ['AFFILIATE', 'PARTNER', 'GOLD', 'PLATINUM', 'STRATEGIC'] }, { key: 'reason', label: 'Reason', kind: 'text', required: true }]}
          onSubmit={async (vals, token) => { await affOps.tier(id, { tier: String(vals['tier']), reason: String(vals['reason']) }, token); notify('Tier set.'); }}
        />
        <StepUpForm
          title="Commission adjustment" cls="FINANCIAL" confirmLabel="Post adjustment"
          fields={[{ key: 'amountMicros', label: 'Amount (micros, ±)', kind: 'number', required: true }, { key: 'reasonCode', label: 'Reason code', kind: 'text', required: true }, { key: 'explanation', label: 'Explanation', kind: 'text', required: true }]}
          onSubmit={async (vals, token) => { await affOps.adjust(id, { amountMicros: Number(vals['amountMicros']), reasonCode: String(vals['reasonCode']), explanation: String(vals['explanation']) }, token); notify('Adjustment posted.'); }}
        />
      </div>
    </Panel>
  );
}

function StatusAction({ id, status, onMsg }: { id: string; status: string; onMsg: (s: string) => void }): JSX.Element {
  const [next, setNext] = useState('PAUSED');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function apply(): Promise<void> {
    if (reason.trim().length < 3) return;
    setBusy(true);
    try { await affOps.status(id, next, reason.trim()); onMsg(`Status set to ${next}.`); setReason(''); }
    catch (e) { onMsg((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="adm-subpanel">
      <h3 style={{ marginTop: 0 }}>Change status</h3>
      <p className="adm-muted" style={{ fontSize: 12 }}>Current: {status}</p>
      <select className="adm-input" value={next} onChange={(e) => setNext(e.target.value)} style={{ width: '100%', marginBottom: 8 }}>
        {['ACTIVE', 'PAUSED', 'SUSPENDED', 'TERMINATED'].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <input className="adm-input" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%', marginBottom: 8 }} />
      <button className="adm-btn" disabled={busy || reason.trim().length < 3} onClick={apply}>Apply</button>
    </div>
  );
}

interface Field { key: string; label: string; kind: 'text' | 'number' | 'select'; options?: string[]; required?: boolean }
function StepUpForm({ title, cls, fields, confirmLabel, onSubmit }: {
  title: string; cls: string; fields: Field[]; confirmLabel: string;
  onSubmit: (vals: Record<string, unknown>, token: string) => Promise<void>;
}): JSX.Element {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const missing = fields.some((f) => f.required && !String(vals[f.key] ?? '').trim()) || password.length < 4;

  async function submit(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      const token = await mintStepUp(password, cls);
      await onSubmit(vals, token);
      setVals({}); setPassword('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="adm-subpanel">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {fields.map((f) => (
        <div key={f.key} style={{ marginBottom: 8 }}>
          {f.kind === 'select' ? (
            <select className="adm-input" style={{ width: '100%' }} value={vals[f.key] ?? f.options?.[0] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}>
              {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input className="adm-input" style={{ width: '100%' }} inputMode={f.kind === 'number' ? 'numeric' : 'text'} placeholder={f.label} value={vals[f.key] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
          )}
        </div>
      ))}
      <input className="adm-input" type="password" style={{ width: '100%', marginBottom: 8 }} placeholder="Your password (step-up)" value={password} onChange={(e) => setPassword(e.target.value)} />
      {err ? <p className="adm-error" style={{ fontSize: 12 }}>{err}</p> : null}
      <button className="adm-btn adm-btn-danger" disabled={busy || missing} onClick={submit}>{busy ? 'Working…' : confirmLabel}</button>
    </div>
  );
}

function PayoutsAdminPanel({ payouts, onDone }: { payouts: Row[]; onDone: () => void }): JSX.Element {
  const [msg, setMsg] = useState<string | null>(null);
  const [payTarget, setPayTarget] = useState<string | null>(null);

  async function act(payoutId: string, action: 'approve' | 'cancel' | 'fail'): Promise<void> {
    let body: Record<string, unknown> = {};
    if (action !== 'approve') {
      const reason = window.prompt(`Reason to ${action}:`) ?? '';
      if (!reason.trim()) return;
      body = { reason: reason.trim() };
    }
    setMsg(null);
    try { await affOps.payoutAction(payoutId, action, body); setMsg(`Payout ${action}d.`); onDone(); }
    catch (e) { setMsg((e as Error).message); }
  }

  return (
    <Panel title="Payouts">
      {msg ? <p className="adm-muted">{msg}</p> : null}
      {payouts.length === 0 ? <p className="adm-muted">No payouts.</p> : (
        <table className="adm-table">
          <thead><tr><th>Requested</th><th className="num">Amount</th><th>Status</th><th>Method</th><th>Actions</th></tr></thead>
          <tbody>
            {payouts.map((p) => {
              const pid = String(p['id']);
              const st = String(p['status']);
              return (
                <tr key={pid}>
                  <td className="adm-muted">{whenD(p['createdAt'])}</td>
                  <td className="num">{formatMicros(Number(p['amountMicros'] ?? 0))}</td>
                  <td><StatusPill status={st} /></td>
                  <td>{String(p['method'] ?? '—')}</td>
                  <td>
                    {['REQUESTED', 'UNDER_REVIEW'].includes(st) ? <><button className="adm-btn" onClick={() => act(pid, 'approve')}>Approve</button>{' '}</> : null}
                    {!['PAID', 'CANCELED', 'FAILED'].includes(st) ? <>
                      <button className="adm-btn" onClick={() => act(pid, 'cancel')}>Cancel</button>{' '}
                      <button className="adm-btn" onClick={() => act(pid, 'fail')}>Fail</button>{' '}
                      <button className="adm-btn adm-btn-danger" onClick={() => setPayTarget(payTarget === pid ? null : pid)}>Mark paid…</button>
                    </> : null}
                    {payTarget === pid ? <MarkPaidForm payoutId={pid} onDone={() => { setPayTarget(null); onDone(); }} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="adm-muted" style={{ marginTop: 10 }}>Marking a payout paid moves money and requires evidence + a FINANCIAL step-up. No external transfer is performed by this console.</p>
    </Panel>
  );
}

function MarkPaidForm({ payoutId, onDone }: { payoutId: string; onDone: () => void }): JSX.Element {
  return (
    <div style={{ marginTop: 10 }}>
      <StepUpForm
        title="Mark paid (evidence required)" cls="FINANCIAL" confirmLabel="Confirm paid"
        fields={[
          { key: 'externalReference', label: 'External reference', kind: 'text', required: true },
          { key: 'method', label: 'Method (e.g. wire, paypal)', kind: 'text', required: true },
          { key: 'evidenceRef', label: 'Evidence reference (optional)', kind: 'text' },
        ]}
        onSubmit={async (vals, token) => {
          await affOps.pay(payoutId, { externalReference: String(vals['externalReference']), method: String(vals['method']), evidenceRef: vals['evidenceRef'] ? String(vals['evidenceRef']) : undefined }, token);
          onDone();
        }}
      />
    </div>
  );
}

void formatCompactMicros;
