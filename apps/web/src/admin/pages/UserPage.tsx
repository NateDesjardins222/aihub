/** One trader: their accounts, their activity and what they have traded. */
import { useState, type JSX } from 'react';
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
import type { AdminAccount, AdminUser, AuditEntry } from '../types';

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
