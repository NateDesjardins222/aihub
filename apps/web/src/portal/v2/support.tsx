/**
 * V2 Support — a REAL, authoritative ticket surface (human-review #3).
 *
 * This is NOT a fixture mock. It is a container wired to the existing, tested customer
 * support API (Milestone 12) via the shared `api` client — the exact endpoints Portal V1
 * uses and that `support-http.test.ts` covers end to end:
 *   GET  /api/v1/support/categories           → topics
 *   GET  /api/v1/support/me/tickets           → the signed-in customer's tickets (own only)
 *   POST /api/v1/support/tickets              → create an AUTHORITATIVE ticket → { id, publicRef }
 *   GET  /api/v1/support/tickets/:id          → one ticket + its public messages
 *   POST /api/v1/support/tickets/:id/messages → customer reply (server forces CUSTOMER sender)
 *   POST /api/v1/support/tickets/:id/reopen   → reopen a resolved ticket
 *
 * Submit does NOT mutate local state in place of the server: it POSTs and then re-reads
 * the authoritative record. Ownership, state transitions and staff/internal fields are
 * all enforced server-side (see SUPPORT_EXISTING_SYSTEM_AUDIT.md). When there is no
 * session (e.g. the unauthenticated dev-review preview), the API returns 401 and the UI
 * shows a truthful "sign in" state — it never fabricates a ticket.
 *
 * NOTE: operator-side handling (reading/responding) already exists under
 * /api/v1/admin/ops/support (owner workstream); this phase does not build Owner Console.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client';
import { V2Section, V2Button, V2Status, V2EmptyState, type StatusKind } from './primitives';
import './support.css';

interface Category { key: string; parentKey: string | null; label: string }
interface TicketRow {
  id: string; publicRef: string; subject: string; categoryKey: string; status: string;
  priority: string; createdAt: string; updatedAt: string; resolvedAt: string | null; resolutionSummaryCustomer: string | null;
}
interface Message { id: string; senderType: string; body: string; senderName: string | null; createdAt: string }
interface TicketView {
  ticket: TicketRow & { csatRating: number | null };
  messages: Message[];
  attachments: Array<{ id: string; filename: string; contentType: string; sizeBytes: number }>;
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open', TRIAGED: 'In review', IN_PROGRESS: 'In progress', WAITING_ON_CUSTOMER: 'Awaiting your reply',
  WAITING_ON_INTERNAL: 'In progress', WAITING_ON_PROVIDER: 'In progress', ESCALATED: 'Escalated', RESOLVED: 'Resolved', CLOSED: 'Closed',
};
const STATUS_KIND: Record<string, StatusKind> = {
  OPEN: 'evaluation', TRIAGED: 'hold', IN_PROGRESS: 'evaluation', WAITING_ON_CUSTOMER: 'hold',
  WAITING_ON_INTERNAL: 'evaluation', WAITING_ON_PROVIDER: 'evaluation', ESCALATED: 'failed', RESOLVED: 'completed', CLOSED: 'neutral',
};
const when = (s: string | null): string => (s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const isAuthErr = (e: unknown): boolean => /401|403|unauth|token|sign/i.test((e as Error)?.message ?? '');

export function V2SupportCenter(): JSX.Element {
  const [pane, setPane] = useState<'home' | 'new' | 'ticket'>('home');
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [authed, setAuthed] = useState(true);

  const load = useCallback(() => {
    api.get<{ tickets: TicketRow[] }>('/api/v1/support/me/tickets')
      .then((d) => { setTickets(d.tickets); setAuthed(true); })
      .catch((e) => { setTickets([]); if (isAuthErr(e)) setAuthed(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="htv2-page" data-testid="htv2-support">
      <header className="htv2-page-head htv2-page-head-row">
        <div>
          <h1 className="ht-t-page-title">Support</h1>
          <p className="ht-t-meta">Open a request and we’ll connect it to the right account, order or payout automatically.</p>
        </div>
        {pane === 'home'
          ? <V2Button variant="primary" size="sm" onClick={() => setPane('new')} testId="htv2-support-new">New request</V2Button>
          : <button className="htv2-link ht-t-nav" onClick={() => { setPane('home'); load(); }}>← All requests</button>}
      </header>

      {!authed && (
        <div className="htv2-support-signin" role="status" data-testid="htv2-support-signin">
          Sign in to view and open support requests. Your requests, their status and replies appear here.
        </div>
      )}

      {pane === 'home' && (
        <V2Section title="Your requests">
          {tickets == null ? (
            <div className="htv2-support-rows"><span className="htv2-ledger-skel" /><span className="htv2-ledger-skel" /></div>
          ) : tickets.length === 0 ? (
            <V2EmptyState
              title="No requests yet"
              hint="When you contact support, your conversation and its status appear here."
              action={<V2Button variant="secondary" size="sm" onClick={() => setPane('new')}>New request</V2Button>}
            />
          ) : (
            <div className="htv2-support-rows" data-testid="htv2-support-tickets">
              {tickets.map((t) => (
                <button key={t.id} className="htv2-support-row" onClick={() => { setOpenId(t.id); setPane('ticket'); }} data-testid="htv2-support-ticket-row">
                  <span className="htv2-support-row-main">
                    <span className="htv2-support-row-subj ht-t-fin-sm">{t.subject}</span>
                    <span className="ht-t-meta ht-num">{t.publicRef} · updated {when(t.updatedAt)}</span>
                  </span>
                  <V2Status kind={STATUS_KIND[t.status] ?? 'neutral'}>{STATUS_LABEL[t.status] ?? t.status}</V2Status>
                </button>
              ))}
            </div>
          )}
        </V2Section>
      )}

      {pane === 'new' && <NewTicket onCreated={(id) => { setOpenId(id); setPane('ticket'); load(); }} />}
      {pane === 'ticket' && openId && <TicketThread ticketId={openId} onChanged={load} />}
    </div>
  );
}

function NewTicket({ onCreated }: { onCreated: (id: string) => void }): JSX.Element {
  const [cats, setCats] = useState<Category[]>([]);
  const [categoryKey, setCategoryKey] = useState('');
  const [subcategoryKey, setSubcategoryKey] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api.get<{ categories: Category[] }>('/api/v1/support/categories').then((d) => setCats(d.categories)).catch(() => setCats([])); }, []);
  const tops = cats.filter((c) => !c.parentKey);
  const subs = cats.filter((c) => c.parentKey === categoryKey);
  const valid = Boolean(categoryKey) && subject.trim().length >= 3 && body.trim().length >= 1;

  async function submit(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      const res = await api.post<{ id: string }>('/api/v1/support/tickets', {
        categoryKey, subcategoryKey: subcategoryKey || null, subject: subject.trim(), body: body.trim(),
      });
      onCreated(res.id);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <V2Section title="New request">
      <div className="htv2-support-form" data-testid="htv2-support-form">
        <label className="htv2-field">
          <span className="ht-t-label">What is it about?</span>
          <select className="htv2-select" value={categoryKey} onChange={(e) => { setCategoryKey(e.target.value); setSubcategoryKey(''); }} data-testid="htv2-support-category">
            <option value="">Choose a topic…</option>
            {tops.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        {subs.length > 0 && (
          <label className="htv2-field">
            <span className="ht-t-label">More specifically</span>
            <select className="htv2-select" value={subcategoryKey} onChange={(e) => setSubcategoryKey(e.target.value)}>
              <option value="">(optional)</option>
              {subs.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        )}
        <label className="htv2-field">
          <span className="ht-t-label">Subject</span>
          <input className="htv2-input" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} data-testid="htv2-support-subject" />
        </label>
        <label className="htv2-field">
          <span className="ht-t-label">Tell us what happened</span>
          <textarea className="htv2-textarea" value={body} rows={6} maxLength={8000} placeholder="Describe what happened, what you expected, and any relevant account or transaction." onChange={(e) => setBody(e.target.value)} data-testid="htv2-support-body" />
        </label>
        {err && <p className="htv2-support-err ht-t-body-sm" data-testid="htv2-support-error">{err}</p>}
        <div>
          <V2Button variant="primary" size="sm" disabled={!valid || busy} onClick={() => void submit()} testId="htv2-support-submit">
            {busy ? 'Submitting…' : 'Submit request'}
          </V2Button>
        </div>
      </div>
    </V2Section>
  );
}

function TicketThread({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }): JSX.Element {
  const [data, setData] = useState<TicketView | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => { api.get<TicketView>(`/api/v1/support/tickets/${ticketId}`).then(setData).catch((e) => setErr((e as Error).message)); }, [ticketId]);
  useEffect(() => { load(); }, [load]);

  async function send(): Promise<void> {
    if (!reply.trim()) return;
    setBusy(true); setErr(null);
    try { await api.post(`/api/v1/support/tickets/${ticketId}/messages`, { body: reply.trim() }); setReply(''); load(); onChanged(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function reopen(): Promise<void> {
    try { await api.post(`/api/v1/support/tickets/${ticketId}/reopen`, { reason: 'Reopened by customer' }); } catch (e) { setErr((e as Error).message); }
    load(); onChanged();
  }

  if (err && !data) return <V2Section title="Request"><p className="htv2-support-err ht-t-body-sm">{err}</p></V2Section>;
  if (!data) return <V2Section title="Request"><p className="ht-t-meta">Loading…</p></V2Section>;
  const t = data.ticket;
  const resolved = t.status === 'RESOLVED' || t.status === 'CLOSED';

  return (
    <div className="htv2-support-thread" data-testid="htv2-support-thread">
      <header className="htv2-support-thread-head">
        <div>
          <div className="ht-t-section">{t.subject}</div>
          <div className="ht-t-meta ht-num">{t.publicRef}</div>
        </div>
        <V2Status kind={STATUS_KIND[t.status] ?? 'neutral'}>{STATUS_LABEL[t.status] ?? t.status}</V2Status>
      </header>

      {resolved && t.resolutionSummaryCustomer && (
        <div className="htv2-support-resolution">
          <span className="ht-t-label">Resolution</span>
          <p className="ht-t-body-sm">{t.resolutionSummaryCustomer}</p>
        </div>
      )}

      <div className="htv2-support-messages">
        {data.messages.map((m) => (
          <div key={m.id} className={`htv2-support-msg htv2-support-msg-${m.senderType === 'CUSTOMER' ? 'me' : 'staff'}`}>
            <div className="ht-t-meta htv2-support-msg-who">{m.senderType === 'CUSTOMER' ? 'You' : (m.senderName ?? 'Happy Trader Support')} · {when(m.createdAt)}</div>
            <div className="htv2-support-msg-body ht-t-body-sm">{m.body}</div>
          </div>
        ))}
      </div>

      {err && <p className="htv2-support-err ht-t-body-sm">{err}</p>}

      {!resolved ? (
        <div className="htv2-support-reply">
          <textarea className="htv2-textarea" value={reply} rows={3} placeholder="Write a reply…" onChange={(e) => setReply(e.target.value)} data-testid="htv2-support-reply" />
          <V2Button variant="primary" size="sm" disabled={busy || !reply.trim()} onClick={() => void send()} testId="htv2-support-send">Send reply</V2Button>
        </div>
      ) : (
        <div className="htv2-support-reopen">
          <button className="htv2-link ht-t-nav" onClick={() => void reopen()} data-testid="htv2-support-reopen">Reopen this request</button>
        </div>
      )}
    </div>
  );
}
