/**
 * Owner Operating System web surfaces (M10-K): Command Center (the landing),
 * a consolidated System page (Doctor / Integrity / Reconciliation / Jobs /
 * Incidents / Alerts / Feature flags / Kill switches), and Staff management.
 *
 * Every number comes from the server (/api/v1/admin/ops/*). Nothing is computed
 * or hardcoded here. Statuses render exactly what the server reports (truthful).
 */
import { useState, type JSX, type ReactNode } from 'react';
import { api } from '../../api/client';
import { Panel, Stat, Money, StatusPill, useLoad } from '../shared';
import { mintStepUp, stepUpPost } from '../lib/stepup';

const OPS = '/api/v1/admin/ops';
const ops = {
  commandCenter: () => api.get<CommandCenter>(`${OPS}/command-center`),
  doctor: () => api.get<Doctor>(`${OPS}/system/doctor`),
  integrity: () => api.get<Integrity>(`${OPS}/system/integrity`),
  reconciliation: () => api.get<{ systems: ReconSys[]; openMismatches: number }>(`${OPS}/system/reconciliation`),
  jobs: () => api.get<{ summary: JobsSummary; jobs: Job[] }>(`${OPS}/jobs`),
  incidents: () => api.get<{ incidents: Incident[]; summary: { open: number } }>(`${OPS}/incidents`),
  alerts: () => api.get<{ alerts: Alert[]; summary: Record<string, number> }>(`${OPS}/alerts`),
  flags: () => api.get<{ known: string[]; flags: Flag[] }>(`${OPS}/config/flags`),
  killSwitches: () => api.get<{ switches: KillSwitch[] }>(`${OPS}/config/kill-switches`),
  providers: () => api.get<{ providers: Provider[] }>(`${OPS}/providers`),
  // Staff/access routes are mounted at /api/v1/admin (not /ops).
  staff: () => api.get<{ staff: Staff[]; invitations: Invite[] }>(`/api/v1/admin/staff`),
  // Mutations. Feature flags need only the permission; kill switches additionally
  // require a KILL_SWITCH step-up token (collected inline, sent as x-stepup-token).
  setFlag: (key: string, environment: string, enabled: boolean) =>
    api.post<Flag>(`${OPS}/config/flags`, { key, environment, enabled }),
  engageKill: (key: string, reason: string, token: string) =>
    stepUpPost<{ key: string; engaged: boolean }>(`${OPS}/config/kill-switches/${encodeURIComponent(key)}/engage`, { reason }, token),
  releaseKill: (key: string, reason: string, token: string) =>
    stepUpPost<{ key: string; engaged: boolean }>(`${OPS}/config/kill-switches/${encodeURIComponent(key)}/release`, { reason }, token),
};

interface CommandCenter {
  overall: string;
  health: { doctor: string; integrityOk: boolean };
  kpis: Record<string, number>;
  attention: Array<{ severity: string; label: string; link: string }>;
  recentActions: Array<{ id: string; action: string; actorLabel: string | null; reason: string | null; createdAt: string }>;
}
interface Doctor { overall: string; checks: Array<{ key: string; status: string; expected: string; actual: string }> }
interface Integrity { ok: boolean; checks: Array<{ key: string; status: string; actual: string; affectedCount: number }> }
interface ReconSys { system: string; status: string; matched: number; mismatch: number; unknown: number }
interface JobsSummary { queued: number; delivered: number; deadLetter: number; retrying: number }
interface Job { id: string; type: string; deadLetter: boolean; attempts: number }
interface Incident { id: string; publicRef: string; title: string; severity: string; status: string }
interface Alert { id: string; severity: string; category: string; title: string; count: number; status: string }
interface Flag { key: string; environment: string; enabled: boolean }
interface KillSwitch { key: string; engaged: boolean; reason: string | null }
interface Provider { provider: string; configured: boolean; verified: boolean; note: string }
interface Staff { id: string; email: string; displayName: string; role: string; status: string; mfaEnrolled: boolean }
interface Invite { id: string; email: string; role: string; status: string }

function overallTone(s: string): string {
  return s === 'HEALTHY' ? 'adm-status-healthy' : s === 'CRITICAL' ? 'adm-status-critical' : 'adm-status-warning';
}

export function CommandCenterPage(): JSX.Element {
  const { data, error, loading, reload } = useLoad(ops.commandCenter, []);
  return (
    <div className="adm-page" data-testid="command-center">
      <div className="adm-page-head">
        <h1>Command Center</h1>
        <div className="adm-spacer" />
        <button className="adm-btn" onClick={reload}>Refresh</button>
      </div>
      {loading ? <p className="adm-muted">Loading…</p> : null}
      {error ? <p className="adm-error">{error}</p> : null}
      {data ? (
        <>
          <div className={`adm-banner ${overallTone(data.overall)}`} data-testid="cc-overall">
            <strong>Overall: {data.overall}</strong>
            <span className="adm-muted"> · System Doctor {data.health.doctor} · Integrity {data.health.integrityOk ? 'OK' : 'FAILED'}</span>
          </div>

          <Panel title="Attention required">
            {data.attention.length === 0 ? (
              <p className="adm-muted">Nothing needs you right now.</p>
            ) : (
              <ul className="adm-attention">
                {data.attention.map((a, i) => (
                  <li key={i} className={a.severity === 'CRITICAL' ? 'adm-neg' : 'adm-warn'}>
                    <StatusPill status={a.severity} /> <a href={a.link}>{a.label}</a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Business KPIs">
            <div className="adm-stat-grid">
              <Stat label="Total customers" value={data.kpis.totalCustomers} sub={`+${data.kpis.newCustomersToday} today`} />
              <Stat label="Active funded" value={data.kpis.activeFundedAccounts} />
              <Stat label="Active evaluations" value={data.kpis.activeEvaluations} />
              <Stat label="Pending payouts" value={data.kpis.pendingPayouts} />
              <Stat label="Paid today" value={data.kpis.payoutsPaidToday} />
              <Stat label="Payout liability" value={<Money micros={data.kpis.payoutLiabilityMicros ?? 0} />} />
              <Stat label="Revenue (purchases)" value={<Money micros={data.kpis.purchaseRevenueMicros ?? 0} />} />
              <Stat label="Open incidents" value={data.kpis.openIncidents} />
              <Stat label="Critical alerts" value={data.kpis.openCriticalAlerts} />
              <Stat label="Dead-letter jobs" value={data.kpis.deadLetterJobs} />
              <Stat label="Integrity failures" value={data.kpis.integrityFailures} />
              <Stat label="Provisioning exceptions" value={data.kpis.provisioningExceptions} />
            </div>
          </Panel>

          <Panel title="Recent admin actions">
            <table className="adm-table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Reason</th></tr></thead>
              <tbody>
                {data.recentActions.map((r) => (
                  <tr key={r.id}><td className="adm-muted">{new Date(r.createdAt).toLocaleString()}</td><td>{r.actorLabel ?? '—'}</td><td>{r.action}</td><td className="adm-muted">{r.reason ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

export function OwnerSystemPage({ mayMutate = false }: { mayMutate?: boolean }): JSX.Element {
  const doctor = useLoad(ops.doctor, []);
  const integrity = useLoad(ops.integrity, []);
  const recon = useLoad(ops.reconciliation, []);
  const jobs = useLoad(ops.jobs, []);
  const incidents = useLoad(ops.incidents, []);
  const alerts = useLoad(ops.alerts, []);
  const flags = useLoad(ops.flags, []);
  const kills = useLoad(ops.killSwitches, []);
  const providers = useLoad(ops.providers, []);
  return (
    <div className="adm-page" data-testid="owner-system">
      <div className="adm-page-head"><h1>System</h1></div>

      <Panel title="System Doctor">
        {doctor.data ? (
          <>
            <p><span className={`adm-pill ${overallTone(doctor.data.overall)}`}>{doctor.data.overall}</span></p>
            <table className="adm-table"><thead><tr><th>Check</th><th>Status</th><th>Expected</th><th>Actual</th></tr></thead>
              <tbody>{doctor.data.checks.map((c) => (<tr key={c.key}><td>{c.key}</td><td><StatusPill status={c.status} /></td><td className="adm-muted">{c.expected}</td><td>{c.actual}</td></tr>))}</tbody>
            </table>
          </>
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Data Integrity">
        {integrity.data ? (
          <table className="adm-table"><thead><tr><th>Invariant</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>{integrity.data.checks.map((c) => (<tr key={c.key}><td>{c.key}</td><td><StatusPill status={c.status} /></td><td className="adm-muted">{c.actual}</td></tr>))}</tbody>
          </table>
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Reconciliation">
        {recon.data ? (
          <table className="adm-table"><thead><tr><th>System</th><th>Status</th><th>Matched</th><th>Mismatch</th><th>Unknown</th></tr></thead>
            <tbody>{recon.data.systems.map((s) => (<tr key={s.system}><td>{s.system}</td><td><StatusPill status={s.status} /></td><td className="num">{s.matched}</td><td className="num">{s.mismatch}</td><td className="num">{s.unknown}</td></tr>))}</tbody>
          </table>
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Providers (truthful)">
        {providers.data ? (
          <table className="adm-table"><thead><tr><th>Provider</th><th>Configured</th><th>Verified</th><th>Note</th></tr></thead>
            <tbody>{providers.data.providers.map((p) => (<tr key={p.provider}><td>{p.provider}</td><td>{p.configured ? 'yes' : 'no'}</td><td>{p.verified ? 'yes' : 'NOT VERIFIED'}</td><td className="adm-muted">{p.note}</td></tr>))}</tbody>
          </table>
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Jobs / Queues">
        {jobs.data ? (
          <div className="adm-stat-grid">
            <Stat label="Queued" value={jobs.data.summary.queued} />
            <Stat label="Delivered" value={jobs.data.summary.delivered} />
            <Stat label="Dead-letter" value={jobs.data.summary.deadLetter} />
            <Stat label="Retrying" value={jobs.data.summary.retrying} />
          </div>
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Incidents">
        {incidents.data ? (
          incidents.data.incidents.length === 0 ? <p className="adm-muted">No incidents.</p> : (
            <table className="adm-table"><thead><tr><th>Ref</th><th>Title</th><th>Severity</th><th>Status</th></tr></thead>
              <tbody>{incidents.data.incidents.map((i) => (<tr key={i.id}><td>{i.publicRef}</td><td>{i.title}</td><td><StatusPill status={i.severity} /></td><td><StatusPill status={i.status} /></td></tr>))}</tbody>
            </table>
          )
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Alerts">
        {alerts.data ? (
          alerts.data.alerts.length === 0 ? <p className="adm-muted">No open alerts.</p> : (
            <table className="adm-table"><thead><tr><th>Severity</th><th>Category</th><th>Title</th><th>Count</th><th>Status</th></tr></thead>
              <tbody>{alerts.data.alerts.map((a) => (<tr key={a.id}><td><StatusPill status={a.severity} /></td><td>{a.category}</td><td>{a.title}</td><td className="num">{a.count}</td><td><StatusPill status={a.status} /></td></tr>))}</tbody>
            </table>
          )
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Feature flags">
        {flags.data ? (
          <FeatureFlagsTable flags={flags.data.flags} mayMutate={mayMutate} onChanged={flags.reload} />
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>

      <Panel title="Kill switches">
        {kills.data ? (
          <KillSwitchesTable switches={kills.data.switches} mayMutate={mayMutate} onChanged={kills.reload} />
        ) : <p className="adm-muted">Loading…</p>}
      </Panel>
    </div>
  );
}

/**
 * Feature flags with an inline toggle (M10-F). The write needs only the
 * `system.feature_flags.manage` permission — no step-up — so a single button
 * flips the flag and reloads. Read-only when the operator may not mutate.
 */
function FeatureFlagsTable({ flags, mayMutate, onChanged }: { flags: Flag[]; mayMutate: boolean; onChanged: () => void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function toggle(f: Flag): Promise<void> {
    setBusy(`${f.key}:${f.environment}`); setErr(null);
    try {
      await ops.setFlag(f.key, f.environment, !f.enabled);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update the flag.');
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {err ? <p className="adm-error">{err}</p> : null}
      <table className="adm-table" data-testid="feature-flags"><thead><tr><th>Key</th><th>Env</th><th>Enabled</th>{mayMutate ? <th /> : null}</tr></thead>
        <tbody>{flags.map((f) => {
          const id = `${f.key}:${f.environment}`;
          return (
            <tr key={id}>
              <td>{f.key}</td>
              <td>{f.environment}</td>
              <td>{f.enabled ? 'on' : 'off'}</td>
              {mayMutate ? (
                <td>
                  <button className="adm-btn" data-testid={`flag-toggle-${f.key}`} disabled={busy === id} onClick={() => void toggle(f)}>
                    {busy === id ? '…' : f.enabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
              ) : null}
            </tr>
          );
        })}</tbody>
      </table>
    </>
  );
}

/**
 * Kill switches with inline engage/release (M10-F). Engaging or releasing is an
 * emergency control: it requires `system.kill_switches.manage` AND a KILL_SWITCH
 * step-up. The operator's password is collected inline, exchanged for a
 * short-lived token, and sent with the mutation — the same reauth the server
 * enforces. A reason is required to engage (and recorded in the hash-chained
 * audit log). Read-only when the operator may not mutate.
 */
function KillSwitchesTable({ switches, mayMutate, onChanged }: { switches: KillSwitch[]; mayMutate: boolean; onChanged: () => void }): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function begin(key: string): void { setOpenKey(key); setReason(''); setPassword(''); setErr(null); }
  function cancel(): void { setOpenKey(null); setReason(''); setPassword(''); setErr(null); }

  async function submit(k: KillSwitch): Promise<void> {
    const engaging = !k.engaged;
    if (engaging && reason.trim().length < 3) { setErr('A reason (3+ characters) is required to engage.'); return; }
    if (password.length === 0) { setErr('Your password is required for this emergency action.'); return; }
    setBusy(true); setErr(null);
    try {
      const token = await mintStepUp(password, 'KILL_SWITCH');
      if (engaging) await ops.engageKill(k.key, reason.trim(), token);
      else await ops.releaseKill(k.key, reason.trim() || 'released', token);
      cancel();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The action failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <table className="adm-table" data-testid="kill-switches"><thead><tr><th>Switch</th><th>State</th><th>Reason</th>{mayMutate ? <th /> : null}</tr></thead>
      <tbody>{switches.map((k) => (
        <FragmentRow key={k.key}>
          <tr>
            <td>{k.key}</td>
            <td><StatusPill status={k.engaged ? 'CRITICAL' : 'HEALTHY'} /> {k.engaged ? 'ENGAGED' : 'released'}</td>
            <td className="adm-muted">{k.reason ?? ''}</td>
            {mayMutate ? (
              <td>
                <button
                  className={k.engaged ? 'adm-btn' : 'adm-btn adm-btn-danger'}
                  data-testid={`kill-${k.engaged ? 'release' : 'engage'}-${k.key}`}
                  onClick={() => (openKey === k.key ? cancel() : begin(k.key))}
                >
                  {k.engaged ? 'Release' : 'Engage'}
                </button>
              </td>
            ) : null}
          </tr>
          {mayMutate && openKey === k.key ? (
            <tr>
              <td colSpan={4}>
                <div className="adm-inline-form" data-testid={`kill-form-${k.key}`}>
                  {!k.engaged ? (
                    <input className="adm-input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  ) : (
                    <input className="adm-input" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  )}
                  <input className="adm-input" type="password" placeholder="Your password (step-up)" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button className="adm-btn adm-btn-primary" disabled={busy} onClick={() => void submit(k)}>
                    {busy ? 'Working…' : k.engaged ? 'Confirm release' : 'Confirm engage'}
                  </button>
                  <button className="adm-btn" disabled={busy} onClick={cancel}>Cancel</button>
                  {err ? <span className="adm-error">{err}</span> : null}
                </div>
              </td>
            </tr>
          ) : null}
        </FragmentRow>
      ))}</tbody>
    </table>
  );
}

/** A keyed fragment so a switch row can be followed by its inline form row. */
function FragmentRow({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}

export function StaffPage(): JSX.Element {
  const { data, error, loading, reload } = useLoad(ops.staff, []);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="adm-page" data-testid="staff-page">
      <div className="adm-page-head"><h1>Staff &amp; access</h1><div className="adm-spacer" /><button className="adm-btn" onClick={reload}>Refresh</button></div>
      {loading ? <p className="adm-muted">Loading…</p> : null}
      {error ? <p className="adm-error">{error}</p> : null}
      {msg ? <p className="adm-muted">{msg}</p> : null}
      {data ? (
        <>
          <Panel title="Staff">
            <table className="adm-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>MFA</th></tr></thead>
              <tbody>{data.staff.map((s) => (<tr key={s.id}><td>{s.displayName}</td><td>{s.email}</td><td>{s.role}</td><td><StatusPill status={s.status} /></td><td>{s.mfaEnrolled ? 'enrolled' : 'NOT ENROLLED'}</td></tr>))}</tbody>
            </table>
          </Panel>
          <Panel title="Invitations">
            {data.invitations.length === 0 ? <p className="adm-muted">No invitations.</p> : (
              <table className="adm-table"><thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
                <tbody>{data.invitations.map((i) => (<tr key={i.id}><td>{i.email}</td><td>{i.role}</td><td><StatusPill status={i.status} /></td></tr>))}</tbody>
              </table>
            )}
            <p className="adm-muted">Staff management (invite, role change, suspend/reactivate, revoke sessions) is served by the API under <code>/api/v1/admin/staff</code> and requires an owner step-up (reauthentication); the invitee sets their own password. A console UI for these actions is not yet built — this page is currently read-only.</p>
          </Panel>
        </>
      ) : null}
      <span hidden onClick={() => setMsg('ok')} />
    </div>
  );
}
