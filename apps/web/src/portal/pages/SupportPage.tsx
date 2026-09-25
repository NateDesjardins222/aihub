/*
 * Customer Support Center — /portal/support.
 *
 * Calm and simple for the customer: "How can we help?", a short new-request form,
 * their existing requests, and a clean conversation thread with the resolution.
 * Internal operational complexity never leaks here — the API only ever returns the
 * customer's own tickets, public messages, and public attachments.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client';
import { Card } from '../lib';

interface Category { key: string; parentKey: string | null; label: string }
interface TicketRow { id: string; publicRef: string; subject: string; categoryKey: string; status: string; priority: string; createdAt: string; updatedAt: string; resolvedAt: string | null; resolutionSummaryCustomer: string | null }
interface Message { id: string; senderType: string; body: string; senderName: string | null; createdAt: string }
interface TicketView { ticket: TicketRow & { csatRating: number | null }; messages: Message[]; attachments: Array<{ id: string; filename: string; contentType: string; sizeBytes: number }> }

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open', TRIAGED: 'In review', IN_PROGRESS: 'In progress', WAITING_ON_CUSTOMER: 'Awaiting your reply',
  WAITING_ON_INTERNAL: 'In progress', WAITING_ON_PROVIDER: 'In progress', ESCALATED: 'Escalated', RESOLVED: 'Resolved', CLOSED: 'Closed',
};
function when(s: string | null): string { return s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; }

export function SupportPage(): JSX.Element {
  const [view, setView] = useState<'home' | 'new' | 'ticket'>('home');
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  const loadTickets = useCallback(() => {
    api.get<{ tickets: TicketRow[] }>('/api/v1/support/me/tickets').then((d) => setTickets(d.tickets)).catch(() => setTickets([]));
  }, []);
  useEffect(() => { loadTickets(); }, [loadTickets]);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h1 className="pt-h1">Support</h1>
        <div style={{ flex: 1 }} />
        {view !== 'home' && <button className="pt-link" onClick={() => { setView('home'); loadTickets(); }}>← All requests</button>}
      </div>

      {view === 'home' && (
        <>
          <p className="pt-sub">How can we help? Open a request and we will connect it to the right account, order or payout automatically.</p>
          <div className="pt-actions" style={{ marginBottom: 20 }}>
            <button className="pt-btn" onClick={() => setView('new')}>New request</button>
          </div>
          <h3 style={{ margin: '10px 0' }}>Your requests</h3>
          {tickets.length === 0 ? (
            <Card><p className="muted">You have no support requests yet.</p></Card>
          ) : (
            <div className="pt-cards">
              {tickets.map((t) => (
                <Card key={t.id}>
                  <button className="pt-link" style={{ fontWeight: 600, fontSize: 15 }} onClick={() => { setOpenId(t.id); setView('ticket'); }}>{t.subject}</button>
                  <p className="muted" style={{ margin: '6px 0' }}>{t.publicRef} · {STATUS_LABEL[t.status] ?? t.status}</p>
                  <p className="muted" style={{ fontSize: 12 }}>Updated {when(t.updatedAt)}</p>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'new' && <NewRequest onCreated={(id) => { setOpenId(id); setView('ticket'); loadTickets(); }} />}
      {view === 'ticket' && openId && <TicketThread ticketId={openId} onChanged={loadTickets} />}
    </>
  );
}

function NewRequest({ onCreated }: { onCreated: (id: string) => void }): JSX.Element {
  const [cats, setCats] = useState<Category[]>([]);
  const [categoryKey, setCategoryKey] = useState('');
  const [subcategoryKey, setSubcategoryKey] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState<{ publicRef: string } | null>(null);

  useEffect(() => { api.get<{ categories: Category[] }>('/api/v1/support/categories').then((d) => setCats(d.categories)).catch(() => setCats([])); }, []);
  const tops = cats.filter((c) => !c.parentKey);
  const subs = cats.filter((c) => c.parentKey === categoryKey);

  useEffect(() => {
    if (!categoryKey) { setDup(null); return; }
    api.post<{ duplicate: { publicRef: string } | null }>('/api/v1/support/duplicate-check', { categoryKey, subcategoryKey: subcategoryKey || null }).then((d) => setDup(d.duplicate)).catch(() => setDup(null));
  }, [categoryKey, subcategoryKey]);

  const valid = categoryKey && subject.trim().length >= 3 && body.trim().length >= 1;
  async function submit(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      const res = await api.post<{ id: string }>('/api/v1/support/tickets', { categoryKey, subcategoryKey: subcategoryKey || null, subject: subject.trim(), body: body.trim() });
      onCreated(res.id);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>New request</h3>
      <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
        <label className="pt-field"><span>What is it about?</span>
          <select value={categoryKey} onChange={(e) => { setCategoryKey(e.target.value); setSubcategoryKey(''); }}>
            <option value="">Choose a topic…</option>
            {tops.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        {subs.length > 0 && (
          <label className="pt-field"><span>More specifically</span>
            <select value={subcategoryKey} onChange={(e) => setSubcategoryKey(e.target.value)}>
              <option value="">(optional)</option>
              {subs.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        )}
        {dup && <p className="muted" style={{ color: 'var(--pt-gold, #d9b25a)' }}>You already have an open request ({dup.publicRef}) in this topic. You can add to it instead of opening a new one.</p>}
        <label className="pt-field"><span>Subject</span><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></label>
        <label className="pt-field"><span>Tell us what happened</span><textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={8000} /></label>
        {err && <p className="pt-error">{err}</p>}
        <div className="pt-actions">
          <button className="pt-btn" disabled={!valid || busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit request'}</button>
        </div>
      </div>
    </Card>
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
  async function attach(file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    setBusy(true); setErr(null);
    try { await api.post(`/api/v1/support/tickets/${ticketId}/attachments`, { filename: file.name, contentType: file.type || 'application/octet-stream', dataBase64: b64 }); load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function reopen(): Promise<void> { await api.post(`/api/v1/support/tickets/${ticketId}/reopen`, { reason: 'Reopened by customer' }).catch((e) => setErr((e as Error).message)); load(); onChanged(); }
  async function rate(n: number): Promise<void> { await api.post(`/api/v1/support/tickets/${ticketId}/csat`, { rating: n }).catch(() => undefined); load(); }

  if (err && !data) return <Card><p className="pt-error">{err}</p></Card>;
  if (!data) return <Card><p className="muted">Loading…</p></Card>;
  const t = data.ticket;
  const resolved = t.status === 'RESOLVED' || t.status === 'CLOSED';

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ margin: 0 }}>{t.subject}</h3>
        <span className="muted">{t.publicRef} · {STATUS_LABEL[t.status] ?? t.status}</span>
      </div>

      {resolved && t.resolutionSummaryCustomer && (
        <div style={{ margin: '14px 0', padding: 14, border: '1px solid var(--pt-line, #232327)', borderRadius: 10 }}>
          <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Resolution</div>
          <p style={{ margin: '6px 0 0' }}>{t.resolutionSummaryCustomer}</p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10, margin: '14px 0' }}>
        {data.messages.map((m) => (
          <div key={m.id} style={{ padding: 12, borderRadius: 10, background: m.senderType === 'CUSTOMER' ? 'var(--pt-panel-2, rgba(255,255,255,0.03))' : 'var(--pt-panel, rgba(255,255,255,0.05))', border: '1px solid var(--pt-line, #232327)' }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{m.senderType === 'CUSTOMER' ? 'You' : (m.senderName ?? 'Happy Trader Support')} · {when(m.createdAt)}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
          </div>
        ))}
      </div>

      {data.attachments.length > 0 && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>Attachments: {data.attachments.map((a) => a.filename).join(', ')}</div>
      )}

      {err && <p className="pt-error">{err}</p>}

      {!resolved ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} placeholder="Write a reply…" />
          <div className="pt-actions" style={{ gap: 10 }}>
            <button className="pt-btn" disabled={busy || !reply.trim()} onClick={send}>Send reply</button>
            <label className="pt-link" style={{ cursor: 'pointer' }}>
              Attach a file
              <input type="file" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); }} />
            </label>
          </div>
        </div>
      ) : (
        <div className="pt-actions" style={{ gap: 12, alignItems: 'center' }}>
          <button className="pt-link" onClick={reopen}>Reopen this request</button>
          {t.csatRating == null && (
            <span className="muted">Was this helpful?{' '}
              {[1, 2, 3, 4, 5].map((n) => <button key={n} className="pt-link" style={{ marginLeft: 4 }} onClick={() => rate(n)}>{n}★</button>)}
            </span>
          )}
          {t.csatRating != null && <span className="muted">You rated this {t.csatRating}★. Thank you.</span>}
        </div>
      )}
    </Card>
  );
}
