/** One trader: their accounts, their activity and what they have traded. */
import { useCallback, useState, type JSX } from 'react';
import { adminApi } from '../api';
import {
  AuditTable,
  ConfirmAction,
  Money,
  Panel,
  StatusPill,
  useLoad,
  when,
  type AdminRouteGo,
} from '../shared';
import type { AdminAccount, AdminUser, AuditEntry, TraderNote } from '../types';

const NOTE_CATEGORIES = ['GENERAL', 'SUPPORT', 'RISK', 'ACCOUNT'] as const;

/**
 * Internal staff notes about a trader. A trader never sees these. The body is
 * rendered as plain text (React escapes it), so any tags or scripts in a note
 * are shown, never run.
 */
function NotesSection({ userId }: { userId: string }): JSX.Element {
  const { data, error, loading, reload } = useLoad(() => adminApi.traderNotes(userId), [userId]);
  const [category, setCategory] = useState<(typeof NOTE_CATEGORIES)[number]>('GENERAL');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = useCallback(() => {
    const trimmed = body.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setFailure(null);
    adminApi
      .createTraderNote(userId, category, trimmed)
      .then(() => {
        setBody('');
        reload();
      })
      .catch((err: Error) => setFailure(err.message))
      .finally(() => setBusy(false));
  }, [body, category, userId, reload]);

  const notes: TraderNote[] = data?.notes ?? [];

  return (
    <Panel title="Staff notes">
      <p className="adm-dim adm-note-hint">Internal. The trader never sees these.</p>
      <div className="adm-note-compose">
        <select
          className="adm-input"
          value={category}
          onChange={(e) => setCategory(e.target.value as (typeof NOTE_CATEGORIES)[number])}
          aria-label="Note category"
        >
          {NOTE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.toLowerCase()}
            </option>
          ))}
        </select>
        <textarea
          className="adm-input adm-note-body"
          value={body}
          maxLength={4000}
          placeholder="Add an internal note…"
          onChange={(e) => setBody(e.target.value)}
        />
        <button className="adm-btn adm-btn-primary" disabled={busy || body.trim().length === 0} onClick={submit}>
          {busy ? 'Saving…' : 'Add note'}
        </button>
      </div>
      {failure ? <p className="adm-error">{failure}</p> : null}
      {error ? <p className="adm-error">{error}</p> : null}
      {loading ? <p className="adm-muted">Loading…</p> : null}
      {!loading && notes.length === 0 ? <p className="adm-muted">No notes yet.</p> : null}
      {notes.length > 0 ? (
        <ul className="adm-note-list">
          {notes.map((note) => (
            <li key={note.id} className="adm-note-item">
              <div className="adm-note-meta">
                <span className={`adm-pill adm-status-${note.category.toLowerCase()}`}>
                  {note.category.toLowerCase()}
                </span>
                <span className="adm-dim">{note.author ?? 'system'}</span>
                <span className="adm-dim">·</span>
                <span className="adm-dim">{when(note.createdAt)}</span>
              </div>
              {note.redacted ? (
                <p className="adm-note-redacted">— redacted —</p>
              ) : (
                <p className="adm-note-text">{note.body}</p>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

interface UserDetail {
  user: AdminUser;
  accounts: AdminAccount[];
  activity: AuditEntry[];
  trades: Array<{
    accountPublicId: string;
    symbol: string;
    side: string;
    qty: number;
    netPnlMicros: number;
    exitTime: number;
    tradeDate: string;
  }>;
}

export function AdminUserPage({ id, go }: { id: string; go: AdminRouteGo }): JSX.Element {
  const { data, error, reload } = useLoad<UserDetail>(() => adminApi.user(id), [id]);
  const [pending, setPending] = useState<'disable' | 'enable' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (error) return <p className="adm-error">{error}</p>;
  if (!data) return <p className="adm-muted">Loading…</p>;

  const disabled = data.user.status !== 'ACTIVE';

  return (
    <div className="adm-page">
      <header className="adm-detail-head">
        <div>
          <h1>{data.user.displayName}</h1>
          <p className="adm-dim">
            {data.user.email} · {data.user.role.replace('_', ' ').toLowerCase()} · joined{' '}
            {when(data.user.createdAt)}
          </p>
        </div>
        <div className="adm-spacer" />
        <StatusPill status={data.user.status} />
        <button
          className={`adm-btn ${disabled ? '' : 'adm-btn-danger'}`}
          onClick={() => setPending(disabled ? 'enable' : 'disable')}
        >
          {disabled ? 'Enable user' : 'Disable user'}
        </button>
      </header>

      {failure ? <p className="adm-error">{failure}</p> : null}

      <Panel title={`Accounts (${data.accounts.length})`}>
        {data.accounts.length === 0 ? (
          <p className="adm-muted">This user has no accounts.</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Name</th>
                <th>Product</th>
                <th>Status</th>
                <th className="num">Balance</th>
                <th className="num">Realized</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <tr
                  key={account.id}
                  className="adm-row-click"
                  onClick={() => go({ name: 'ACCOUNT', id: account.id })}
                >
                  <td className="num">{account.publicId}</td>
                  <td>{account.name}</td>
                  <td className="adm-dim">
                    {account.product ? `${account.product.name} v${account.product.version}` : '—'}
                  </td>
                  <td>
                    <StatusPill status={account.status} />
                  </td>
                  <td className="num">
                    <Money micros={account.balanceMicros} />
                  </td>
                  <td className="num">
                    <Money micros={account.realizedPnlMicros} sign />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Recent trades">
        {data.trades.length === 0 ? (
          <p className="adm-muted">Nothing closed yet.</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Instrument</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Net</th>
                <th>Closed</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.map((trade, index) => (
                <tr key={`${trade.accountPublicId}-${trade.exitTime}-${index}`}>
                  <td className="num">{trade.accountPublicId}</td>
                  <td>{trade.symbol}</td>
                  <td>{trade.side}</td>
                  <td className="num">{trade.qty}</td>
                  <td className="num">
                    <Money micros={trade.netPnlMicros} sign />
                  </td>
                  <td className="num adm-dim">{when(trade.exitTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <NotesSection userId={id} />

      <Panel title="Activity">
        <AuditTable entries={data.activity} go={go} />
      </Panel>

      {pending ? (
        <ConfirmAction
          title={pending === 'disable' ? 'Disable this user' : 'Enable this user'}
          description={
            pending === 'disable'
              ? 'They will not be able to sign in, and an open session cannot be refreshed. Their accounts and history are untouched.'
              : 'They will be able to sign in again.'
          }
          confirmLabel={pending === 'disable' ? 'Disable user' : 'Enable user'}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            setBusy(true);
            setFailure(null);
            adminApi
              .userAction(id, pending, reason)
              .then(() => {
                setPending(null);
                reload();
              })
              .catch((err: Error) => setFailure(err.message))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
