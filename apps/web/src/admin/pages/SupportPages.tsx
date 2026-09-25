/**
 * Owner OS — Support operations (Milestone 12-D/F/H/I).
 *
 * The support inbox (KPIs + filtered, keyset-paginated queue) and the full ticket
 * workspace: the conversation with internal notes, the investigation context, links,
 * evidence, diagnostics, and the remediation approval workflow. Every figure comes
 * from the server (/api/v1/admin/ops/support/*); this file computes nothing about
 * money. Support investigates and REQUESTS remediation — authorized roles approve and
 * execute; the money itself only ever moves through the canonical domain services.
 */
import { useCallback, useState, type JSX } from 'react';
import { api } from '../../api/client';
import { Panel, Stat, useLoad } from '../shared';
import type { AdminRouteGo } from '../shared';

const OPS = '/api/v1/admin/ops';
type Row = Record<string, unknown>;

interface Overview {
  open: number; unassigned: number; breached: number; dueSoon: number; urgent: number;
  waitingOnCustomer: number; waitingOnProvider: number; waitingOnInternal: number; escalated: number;
  resolvedToday: number; reopened: number; csatAverage: number; csatCount: number;
  pendingRemediationApprovals: number; byCategory: Record<string, number>; byStatus: Record<string, number>;
}
interface InboxRow {
  id: string; publicRef: string; subject: string; categoryKey: string; status: string; priority: string;
  team: string | null; assigneeUserId: string | null; tags: string[] | null; sla: string;
  incidentId: string | null; customerName: string | null; updatedAt: string; createdAt: string;
}
interface Enums { priorities: string[]; statuses: string[]; resolutionCodes: string[]; rootCauses: string[]; remediationTypes: string[]; teams: string[] }

const supOps = {
  overview: () => api.get<Overview>(`${OPS}/support/overview`),
  inbox: (q: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    return api.get<{ tickets: InboxRow[]; nextCursor: string | null }>(`${OPS}/support/inbox?${p.toString()}`);
  },
  config: () => api.get<{ enums: Enums; categories: Row[]; settings: Record<string, unknown> }>(`${OPS}/support/config`),
  ticket: (id: string) => api.get<Row>(`${OPS}/support/tickets/${id}`),
  reply: (id: string, body: string) => api.post<{ id: string }>(`${OPS}/support/tickets/${id}/reply`, { body }),
  note: (id: string, body: string) => api.post<{ id: string }>(`${OPS}/support/tickets/${id}/note`, { body }),
  assign: (id: string, b: Row) => api.post(`${OPS}/support/tickets/${id}/assign`, b),
  priority: (id: string, priority: string) => api.post(`${OPS}/support/tickets/${id}/priority`, { priority }),
  status: (id: string, to: string) => api.post(`${OPS}/support/tickets/${id}/status`, { to }),
  tags: (id: string, tags: string[]) => api.post(`${OPS}/support/tickets/${id}/tags`, { tags }),
  escalate: (id: string, b: Row) => api.post(`${OPS}/support/tickets/${id}/escalate`, b),
  resolve: (id: string, b: Row) => api.post(`${OPS}/support/tickets/${id}/resolve`, b),
  reopen: (id: string, reason: string) => api.post(`${OPS}/support/tickets/${id}/reopen`, { reason }),
  link: (id: string, b: Row) => api.post(`${OPS}/support/tickets/${id}/link`, b),
  unlink: (id: string, linkId: string) => api.post(`${OPS}/support/tickets/${id}/unlink`, { linkId }),
  evidence: (id: string, b: Row) => api.post(`${OPS}/support/tickets/${id}/evidence`, b),
  diagnostics: (objectType: string, objectId: string) => api.get<Row>(`${OPS}/support/diagnostics?objectType=${encodeURIComponent(objectType)}&objectId=${encodeURIComponent(objectId)}`),
  requestRemediation: (id: string, b: Row) => api.post<{ id: string }>(`${OPS}/support/tickets/${id}/remediations`, b),
  approve: (rid: string) => api.post<{ status: string }>(`${OPS}/support/remediations/${rid}/approve`, {}),
  deny: (rid: string, reason: string) => api.post(`${OPS}/support/remediations/${rid}/deny`, { reason }),
  execute: (rid: string) => api.post<{ status: string; failureReason?: string | null }>(`${OPS}/support/remediations/${rid}/execute`, {}),
};

function whenT(v: unknown): string { return v ? new Date(String(v)).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
const SLA_TONE: Record<string, string> = { BREACHED: 'adm-neg', DUE_SOON: 'adm-warn', ON_TRACK: 'adm-pos', MET: 'adm-pos', PAUSED: 'adm-muted', NONE: 'adm-muted' };

function Pill({ text, tone }: { text: string; tone?: string }): JSX.Element {
  return <span className={`adm-pill ${tone ?? ''}`} style={{ textTransform: 'none' }}>{text}</span>;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------
const VIEWS: Array<{ key: string; label: string }> = [
  { key: 'ALL', label: 'All open' }, { key: 'UNASSIGNED', label: 'Unassigned' }, { key: 'MINE', label: 'Mine' },
  { key: 'URGENT', label: 'Urgent' }, { key: 'ESCALATED', label: 'Escalated' },
  { key: 'WAITING_CUSTOMER', label: 'Awaiting customer' }, { key: 'WAITING_PROVIDER', label: 'Awaiting provider' },
  { key: 'RESOLVED', label: 'Resolved' }, { key: 'REOPENED', label: 'Reopened' },
];

export function SupportInboxPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const ov = useLoad(supOps.overview, []);
  const [view, setView] = useState('ALL');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const inbox = useLoad(() => supOps.inbox({ view, q: qLive }), [view, qLive]);

  return (
    <div className="adm-page" data-testid="support-inbox">
      <div className="adm-page-head"><h1>Support</h1><div className="adm-spacer" /><button className="adm-btn" onClick={() => { ov.reload(); inbox.reload(); }}>Refresh</button></div>
      {ov.error ? <p className="adm-error">{ov.error}</p> : null}
      {ov.data ? (
        <Panel title="Support at a glance">
          <div className="adm-stat-grid">
            <Stat label="Open" value={ov.data.open} />
            <Stat label="Unassigned" value={ov.data.unassigned} />
            <Stat label="SLA breached" value={<span className={ov.data.breached > 0 ? 'adm-neg' : ''}>{ov.data.breached}</span>} />
            <Stat label="Due soon" value={ov.data.dueSoon} />
            <Stat label="Urgent" value={ov.data.urgent} />
            <Stat label="Escalated" value={ov.data.escalated} />
            <Stat label="Awaiting customer" value={ov.data.waitingOnCustomer} />
            <Stat label="Awaiting provider" value={ov.data.waitingOnProvider} />
            <Stat label="Resolved today" value={ov.data.resolvedToday} />
            <Stat label="Reopened" value={ov.data.reopened} />
            <Stat label="Pending remediations" value={<span className={ov.data.pendingRemediationApprovals > 0 ? 'adm-warn' : ''}>{ov.data.pendingRemediationApprovals}</span>} />
            <Stat label="CSAT" value={ov.data.csatCount > 0 ? `${ov.data.csatAverage.toFixed(1)}★` : '—'} sub={`${ov.data.csatCount} rated`} />
          </div>
        </Panel>
      ) : <p className="adm-muted">Loading…</p>}

      <Panel
        title="Inbox"
        action={
          <form onSubmit={(e) => { e.preventDefault(); setQLive(q.trim()); }} style={{ display: 'flex', gap: 8 }}>
            <input className="adm-input" placeholder="Search ref or subject…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="adm-btn" type="submit">Search</button>
          </form>
        }
      >
        <div className="adm-tabs" style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {VIEWS.map((v) => (
            <button key={v.key} className={`adm-chip ${view === v.key ? 'adm-chip-on' : ''}`} onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </div>
        {inbox.error ? <p className="adm-error">{inbox.error}</p> : null}
        {inbox.loading ? <p className="adm-muted">Loading…</p> : null}
        {inbox.data && inbox.data.tickets.length === 0 ? <p className="adm-muted">No tickets match this view.</p> : null}
        {inbox.data && inbox.data.tickets.length > 0 ? (
          <table className="adm-table">
            <thead><tr><th>Ref</th><th>Subject</th><th>Customer</th><th>Category</th><th>Priority</th><th>Status</th><th>SLA</th><th>Updated</th></tr></thead>
            <tbody>
              {inbox.data.tickets.map((t) => (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => go({ name: 'TICKET', id: t.id })}>
                  <td className="num">{t.publicRef}</td>
                  <td>{t.subject}</td>
                  <td className="adm-muted">{t.customerName ?? '—'}</td>
                  <td className="adm-muted">{t.categoryKey}</td>
                  <td><Pill text={t.priority} tone={t.priority === 'URGENT' ? 'adm-neg' : t.priority === 'HIGH' ? 'adm-warn' : ''} /></td>
                  <td><Pill text={t.status.replace(/_/g, ' ').toLowerCase()} /></td>
                  <td><Pill text={t.sla.replace(/_/g, ' ').toLowerCase()} tone={SLA_TONE[t.sla]} /></td>
                  <td className="adm-muted">{whenT(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ticket workspace
// ---------------------------------------------------------------------------
export function SupportTicketPage({ id, go }: { id: string; go: AdminRouteGo }): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => supOps.ticket(id), [id]);
  const cfg = useLoad(supOps.config, []);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg(ok); reload(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }, [reload]);

  if (loading) return <div className="adm-page"><p className="adm-muted">Loading…</p></div>;
  if (error || !data) return <div className="adm-page"><p className="adm-error">{error ?? 'Not found.'}</p></div>;

  const ticket = data['ticket'] as Row;
  const customer = data['customer'] as Row | null;
  const messages = (data['messages'] as Row[]) ?? [];
  const links = (data['links'] as Row[]) ?? [];
  const evidence = (data['evidence'] as Row[]) ?? [];
  const remediations = (data['remediations'] as Row[]) ?? [];
  const timeline = (data['timeline'] as Row[]) ?? [];
  const context = data['context'] as Row | null;
  const enums = cfg.data?.enums;
  const status = String(ticket['status']);
  const terminal = status === 'RESOLVED' || status === 'CLOSED';

  return (
    <div className="adm-page" data-testid="support-ticket">
      <div className="adm-page-head">
        <button className="adm-link" onClick={() => go({ name: 'SUPPORT' })}>← Inbox</button>
        <h1 style={{ marginLeft: 12 }}>{String(ticket['subject'])}</h1>
        <div className="adm-spacer" />
        <span className="num adm-muted">{String(ticket['publicRef'])}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Pill text={status.replace(/_/g, ' ').toLowerCase()} />
        <Pill text={String(ticket['priority'])} tone={ticket['priority'] === 'URGENT' ? 'adm-neg' : ''} />
        <Pill text={`SLA: ${String(ticket['sla']).replace(/_/g, ' ').toLowerCase()}`} tone={SLA_TONE[String(ticket['sla'])]} />
        {ticket['team'] ? <Pill text={String(ticket['team'])} /> : null}
      </div>
      {msg ? <p className="adm-muted">{msg}</p> : null}

      <div className="adm-two-col" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          <Conversation messages={messages} />
          {!terminal ? <ReplyBox onReply={(b) => act(() => supOps.reply(id, b), 'Reply sent.')} onNote={(b) => act(() => supOps.note(id, b), 'Internal note added.')} busy={busy} /> : null}
          <RemediationPanel ticketId={id} remediations={remediations} enums={enums} act={act} busy={busy} />
          <InvestigationPanel links={links} evidence={evidence} timeline={timeline} ticketId={id} act={act} busy={busy} />
        </div>

        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          <ActionsPanel ticket={ticket} enums={enums} terminal={terminal} act={act} busy={busy} id={id} />
          <ContextPanel customer={customer} context={context} />
        </div>
      </div>
    </div>
  );
}

function Conversation({ messages }: { messages: Row[] }): JSX.Element {
  return (
    <Panel title="Conversation">
      {messages.length === 0 ? <p className="adm-muted">No messages yet.</p> : null}
      <div style={{ display: 'grid', gap: 10 }}>
        {messages.map((m) => {
          const internal = String(m['visibility']) === 'INTERNAL';
          const sender = String(m['senderType']);
          return (
            <div key={String(m['id'])} className="adm-msg" style={{ padding: 12, borderRadius: 8, border: '1px solid var(--adm-line, #2a2a30)', background: internal ? 'var(--adm-warn-bg, rgba(217,178,90,0.08))' : 'var(--adm-panel-2, rgba(255,255,255,0.02))' }}>
              <div className="adm-muted" style={{ fontSize: 12, marginBottom: 4, display: 'flex', gap: 8 }}>
                <strong>{sender === 'CUSTOMER' ? 'Customer' : sender === 'SYSTEM' ? 'System' : String(m['senderName'] ?? 'Staff')}</strong>
                {internal ? <span className="adm-warn">· internal note</span> : null}
                <span>· {whenT(m['createdAt'])}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{String(m['body'])}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function ReplyBox({ onReply, onNote, busy }: { onReply: (b: string) => void; onNote: (b: string) => void; busy: boolean }): JSX.Element {
  const [tab, setTab] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const internal = tab === 'note';
  function send(): void { if (!text.trim()) return; if (internal) onNote(text.trim()); else onReply(text.trim()); setText(''); }
  return (
    <Panel title="Respond">
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button className={`adm-chip ${tab === 'reply' ? 'adm-chip-on' : ''}`} onClick={() => setTab('reply')}>Public reply</button>
        <button className={`adm-chip ${tab === 'note' ? 'adm-chip-on' : ''}`} onClick={() => setTab('note')}>Internal note</button>
      </div>
      <textarea className="adm-input" rows={4} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} placeholder={internal ? 'Visible to staff only — never the customer' : 'This goes to the customer'} />
      {internal ? <p className="adm-muted" style={{ fontSize: 12 }}>Internal notes are never shown to the customer.</p> : null}
      <div className="adm-dialog-actions" style={{ marginTop: 8 }}>
        <button className="adm-btn adm-btn-primary" disabled={busy || !text.trim()} onClick={send}>{internal ? 'Add note' : 'Send reply'}</button>
      </div>
    </Panel>
  );
}

function ActionsPanel({ ticket, enums, terminal, act, busy, id }: { ticket: Row; enums?: Enums; terminal: boolean; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: boolean; id: string }): JSX.Element {
  const [resolveOpen, setResolveOpen] = useState(false);
  const [escOpen, setEscOpen] = useState(false);
  return (
    <Panel title="Actions">
      <div style={{ display: 'grid', gap: 10 }}>
        <label className="adm-field"><span>Priority</span>
          <select className="adm-input" value={String(ticket['priority'])} disabled={busy} onChange={(e) => act(() => supOps.priority(id, e.target.value), 'Priority updated.')}>
            {(enums?.priorities ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="adm-field"><span>Status</span>
          <select className="adm-input" value={String(ticket['status'])} disabled={busy} onChange={(e) => act(() => supOps.status(id, e.target.value), 'Status updated.')}>
            {(enums?.statuses ?? []).map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
        </label>
        <label className="adm-field"><span>Team</span>
          <select className="adm-input" value={String(ticket['team'] ?? '')} disabled={busy} onChange={(e) => act(() => supOps.assign(id, { assigneeUserId: (ticket['assigneeUserId'] as string) ?? null, team: e.target.value || null }), 'Team updated.')}>
            <option value="">(unassigned team)</option>
            {(enums?.teams ?? []).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}
          </select>
        </label>
        <button className="adm-btn" disabled={busy} onClick={() => act(() => supOps.assign(id, { assigneeUserId: null, team: (ticket['team'] as string) ?? null }), 'Unassigned.')}>Unassign owner</button>
        {!terminal ? <button className="adm-btn" disabled={busy} onClick={() => setEscOpen(true)}>Escalate…</button> : null}
        {!terminal ? <button className="adm-btn adm-btn-primary" disabled={busy} onClick={() => setResolveOpen(true)}>Resolve…</button> : null}
        {terminal ? <button className="adm-btn" disabled={busy} onClick={() => act(() => supOps.reopen(id, 'reopened by staff'), 'Reopened.')}>Reopen</button> : null}
      </div>
      {resolveOpen ? <ResolveDialog enums={enums} busy={busy} onCancel={() => setResolveOpen(false)} onConfirm={(b) => { act(() => supOps.resolve(id, b), 'Resolved.'); setResolveOpen(false); }} /> : null}
      {escOpen ? <EscalateDialog enums={enums} busy={busy} onCancel={() => setEscOpen(false)} onConfirm={(b) => { act(() => supOps.escalate(id, b), 'Escalated.'); setEscOpen(false); }} /> : null}
    </Panel>
  );
}

function ResolveDialog({ enums, busy, onCancel, onConfirm }: { enums?: Enums; busy: boolean; onCancel: () => void; onConfirm: (b: Row) => void }): JSX.Element {
  const [code, setCode] = useState(enums?.resolutionCodes[0] ?? '');
  const [rootCause, setRootCause] = useState('');
  const [customerSummary, setCustomerSummary] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  return (
    <div className="adm-scrim" role="dialog" aria-modal="true">
      <div className="adm-dialog" style={{ maxWidth: 560 }}>
        <h3>Resolve ticket</h3>
        <label className="adm-field"><span>Resolution code</span>
          <select className="adm-input" value={code} onChange={(e) => setCode(e.target.value)}>{(enums?.resolutionCodes ?? []).map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
        </label>
        <label className="adm-field"><span>Root cause (internal)</span>
          <select className="adm-input" value={rootCause} onChange={(e) => setRootCause(e.target.value)}><option value="">(none)</option>{(enums?.rootCauses ?? []).map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
        </label>
        <label className="adm-field"><span>Summary for the customer (they will see this)</span>
          <textarea className="adm-input" rows={3} value={customerSummary} onChange={(e) => setCustomerSummary(e.target.value)} />
        </label>
        <label className="adm-field"><span>Internal notes (never shown to customer)</span>
          <textarea className="adm-input" rows={2} value={internalNotes} onChange={(e) => setInternalNotes(e.target.value)} />
        </label>
        <div className="adm-dialog-actions">
          <button className="adm-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="adm-btn adm-btn-primary" disabled={busy || !code || customerSummary.trim().length < 1} onClick={() => onConfirm({ resolutionCode: code, rootCause: rootCause || undefined, customerSummary: customerSummary.trim(), internalNotes: internalNotes.trim() || undefined })}>Resolve</button>
        </div>
      </div>
    </div>
  );
}

function EscalateDialog({ enums, busy, onCancel, onConfirm }: { enums?: Enums; busy: boolean; onCancel: () => void; onConfirm: (b: Row) => void }): JSX.Element {
  const [team, setTeam] = useState(enums?.teams[0] ?? '');
  const [priority, setPriority] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="adm-scrim" role="dialog" aria-modal="true">
      <div className="adm-dialog" style={{ maxWidth: 520 }}>
        <h3>Escalate ticket</h3>
        <label className="adm-field"><span>To team</span>
          <select className="adm-input" value={team} onChange={(e) => setTeam(e.target.value)}>{(enums?.teams ?? []).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
        </label>
        <label className="adm-field"><span>Raise priority to</span>
          <select className="adm-input" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">(keep)</option>{(enums?.priorities ?? []).map((p) => <option key={p} value={p}>{p}</option>)}</select>
        </label>
        <label className="adm-field"><span>Reason</span><input className="adm-input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="adm-dialog-actions">
          <button className="adm-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="adm-btn adm-btn-primary" disabled={busy || !team || reason.trim().length < 1} onClick={() => onConfirm({ team, priority: priority || undefined, reason: reason.trim() })}>Escalate</button>
        </div>
      </div>
    </div>
  );
}

function RemediationPanel({ ticketId, remediations, enums, act, busy }: { ticketId: string; remediations: Row[]; enums?: Enums; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');

  function request(): void {
    const amt = amount.trim() ? Math.round(Number(amount) * 1_000_000) : null;
    act(() => supOps.requestRemediation(ticketId, { type, reason: reason.trim(), amountMicros: amt }), 'Remediation requested for approval.');
    setOpen(false); setType(''); setReason(''); setAmount('');
  }

  return (
    <Panel title="Remediation" action={<button className="adm-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Request remediation'}</button>}>
      <p className="adm-muted" style={{ fontSize: 12, marginTop: 0 }}>Support requests; an authorized approver reviews and executes. Money only ever moves through the canonical services with four-eyes approval.</p>
      {open ? (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12, padding: 12, border: '1px solid var(--adm-line, #2a2a30)', borderRadius: 8 }}>
          <label className="adm-field"><span>Type</span>
            <select className="adm-input" value={type} onChange={(e) => setType(e.target.value)}><option value="">Choose…</option>{(enums?.remediationTypes ?? []).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>)}</select>
          </label>
          <label className="adm-field"><span>Amount (USD, if applicable)</span><input className="adm-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="optional" /></label>
          <label className="adm-field"><span>Reason / justification</span><textarea className="adm-input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="adm-btn adm-btn-primary" disabled={busy || !type || reason.trim().length < 1} onClick={request}>Submit for approval</button>
        </div>
      ) : null}
      {remediations.length === 0 ? <p className="adm-muted">No remediation requested.</p> : (
        <table className="adm-table">
          <thead><tr><th>Ref</th><th>Type</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {remediations.map((r) => {
              const rid = String(r['id']);
              const st = String(r['status']);
              const amt = r['amountMicros'] != null ? `$${(Number(r['amountMicros']) / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—';
              return (
                <tr key={rid}>
                  <td className="num">{String(r['publicRef'])}</td>
                  <td>{String(r['type']).replace(/_/g, ' ').toLowerCase()}</td>
                  <td className="num">{amt}</td>
                  <td><Pill text={st.replace(/_/g, ' ').toLowerCase()} tone={st === 'EXECUTED' ? 'adm-pos' : st === 'FAILED' || st === 'DENIED' ? 'adm-neg' : ''} /></td>
                  <td>
                    {st === 'REQUESTED' || st === 'UNDER_REVIEW' ? (
                      <span style={{ display: 'flex', gap: 6 }}>
                        <button className="adm-btn" disabled={busy} onClick={() => act(() => supOps.approve(rid), 'Approved.')}>Approve</button>
                        <button className="adm-btn" disabled={busy} onClick={() => { const why = window.prompt('Reason for denial:') ?? ''; if (why.trim()) act(() => supOps.deny(rid, why.trim()), 'Denied.'); }}>Deny</button>
                      </span>
                    ) : null}
                    {st === 'APPROVED' ? <button className="adm-btn adm-btn-primary" disabled={busy} onClick={() => act(() => supOps.execute(rid), 'Executed.')}>Execute</button> : null}
                    {st === 'FAILED' && r['failureReason'] ? <span className="adm-neg" style={{ fontSize: 12 }}>{String(r['failureReason'])}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function InvestigationPanel({ links, evidence, timeline, ticketId, act, busy }: { links: Row[]; evidence: Row[]; timeline: Row[]; ticketId: string; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; busy: boolean }): JSX.Element {
  const [diag, setDiag] = useState<Row | null>(null);
  const [diagErr, setDiagErr] = useState<string | null>(null);
  async function runDiag(objectType: string, objectId: string): Promise<void> {
    setDiag(null); setDiagErr(null);
    try { setDiag(await supOps.diagnostics(objectType, objectId)); } catch (e) { setDiagErr((e as Error).message); }
  }
  function addLink(): void {
    const objectType = window.prompt('Object type (e.g. ACCOUNT, ORDER, PAYOUT):') ?? '';
    const objectId = window.prompt('Object id / public ref:') ?? '';
    if (objectType.trim() && objectId.trim()) act(() => supOps.link(ticketId, { objectType: objectType.trim().toUpperCase(), objectId: objectId.trim() }), 'Linked.');
  }
  return (
    <Panel title="Investigation" action={<button className="adm-btn" onClick={addLink}>Link an object</button>}>
      <h4 style={{ margin: '0 0 6px' }}>Linked objects</h4>
      {links.length === 0 ? <p className="adm-muted">Nothing linked yet.</p> : (
        <table className="adm-table">
          <thead><tr><th>Type</th><th>Reference</th><th>Label</th><th></th></tr></thead>
          <tbody>
            {links.map((l) => (
              <tr key={String(l['id'])}>
                <td>{String(l['objectType'])}</td>
                <td className="num">{String(l['objectId'])}</td>
                <td className="adm-muted">{String(l['label'] ?? '—')}</td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="adm-btn" disabled={busy} onClick={() => runDiag(String(l['objectType']), String(l['objectId']))}>What happened?</button>
                  <button className="adm-btn" disabled={busy} onClick={() => act(() => supOps.unlink(ticketId, String(l['id'])), 'Unlinked.')}>Unlink</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {diagErr ? <p className="adm-error">{diagErr}</p> : null}
      {diag ? (
        <div style={{ marginTop: 12, padding: 12, border: '1px solid var(--adm-line, #2a2a30)', borderRadius: 8 }}>
          <h4 style={{ margin: '0 0 6px' }}>What happened — {String(diag['headline'] ?? 'facts')}</h4>
          <table className="adm-table">
            <tbody>
              {((diag['facts'] as Array<{ label: string; value: string }>) ?? []).map((f, i) => (
                <tr key={i}><td className="adm-muted">{f.label}</td><td>{f.value}</td></tr>
              ))}
            </tbody>
          </table>
          {((diag['reasonCodes'] as string[]) ?? []).length > 0 ? (
            <p className="adm-muted" style={{ fontSize: 12, marginBottom: 0 }}>Reason codes: {(diag['reasonCodes'] as string[]).join(', ')}</p>
          ) : null}
        </div>
      ) : null}

      <h4 style={{ margin: '16px 0 6px' }}>Evidence</h4>
      {evidence.length === 0 ? <p className="adm-muted">No evidence captured.</p> : (
        <ul className="adm-list">{evidence.map((e) => <li key={String(e['id'])}>{String(e['sourceType'])}: <span className="num">{String(e['sourceRef'])}</span> {e['description'] ? `— ${String(e['description'])}` : ''}</li>)}</ul>
      )}

      <h4 style={{ margin: '16px 0 6px' }}>Investigation timeline</h4>
      {timeline.length === 0 ? <p className="adm-muted">No correlated events.</p> : (
        <ul className="adm-list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {timeline.map((ev, i) => (
            <li key={i}><span className="adm-muted">{whenT(ev['at'] ?? ev['occurredAt'] ?? ev['createdAt'])}</span> — {String(ev['type'] ?? ev['kind'] ?? ev['action'] ?? 'event')} {ev['summary'] ? `· ${String(ev['summary'])}` : ''}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ContextPanel({ customer, context }: { customer: Row | null; context: Row | null }): JSX.Element {
  return (
    <Panel title="Customer">
      {customer ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>{String(customer['displayName'] ?? '—')}</div>
          <div className="adm-muted">{String(customer['email'] ?? '')}</div>
        </div>
      ) : <p className="adm-muted">No customer record.</p>}
      {context ? (
        <table className="adm-table">
          <tbody>
            {Object.entries(context).filter(([, v]) => typeof v !== 'object' || v === null).map(([k, v]) => (
              <tr key={k}><td className="adm-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</td><td>{v == null ? '—' : String(v)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Panel>
  );
}
