/**
 * One account, in full: what it is, what it is doing right now, what it has
 * done, and what an operator may do to it.
 *
 * The live panel polls the engine's own valuation. It is the same figure the
 * trader's terminal is pushed over the WebSocket, so an operator on the phone
 * to a trader is looking at the same number they are.
 */
import { useEffect, useState, type JSX } from 'react';
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
import type { AdminAccountDetail, AdminLiveView } from '../types';

interface ActionDef {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly danger?: boolean;
  /** Statuses the action applies to. */
  readonly from: readonly string[];
}

const ACTIONS: readonly ActionDef[] = [
  {
    id: 'activate',
    label: 'Activate',
    title: 'Activate this account',
    description: 'The trader will be able to place orders on it.',
    from: ['PENDING', 'DISABLED'],
  },
  {
    id: 'lock',
    label: 'Lock',
    title: 'Lock this account',
    description:
      'Working orders are cancelled and no new ones may be placed. An open position is left alone - closing it is a trading decision with a P&L consequence, so flatten it explicitly if that is what you mean.',
    danger: true,
    from: ['ACTIVE', 'GOAL_REACHED', 'PENDING'],
  },
  {
    id: 'unlock',
    label: 'Unlock',
    title: 'Unlock this account',
    description: 'Trading resumes under the same rules.',
    from: ['LOCKED'],
  },
  {
    id: 'disable',
    label: 'Disable',
    title: 'Disable this account',
    description:
      'Working orders are cancelled and the account disappears from the trader’s selector. Nothing is deleted.',
    danger: true,
    from: ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED', 'PASSED', 'FAILED'],
  },
  {
    id: 'enable',
    label: 'Enable',
    title: 'Enable this account',
    description: 'It becomes tradeable again.',
    from: ['DISABLED'],
  },
  {
    id: 'reset',
    label: 'Reset',
    title: 'Reset this account',
    description:
      'Positions are closed through the ordinary execution path, working orders cancelled, the balance returned to the product’s starting balance and the rule state cleared. The current lifecycle is CLOSED, not deleted: every order, fill and trade stays readable here. If a position cannot be closed - the market is shut - the reset is refused rather than completed with an invented price.',
    danger: true,
    from: ['ACTIVE', 'GOAL_REACHED', 'LOCKED', 'PASSED', 'FAILED', 'PENDING'],
  },
  {
    id: 'archive',
    label: 'Archive',
    title: 'Archive this account',
    description:
      'It is finished with: hidden from the trader, refused new orders, and its history kept exactly where it is.',
    danger: true,
    from: ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED', 'PASSED', 'FAILED', 'DISABLED'],
  },
];

export function AdminAccountPage({
  id,
  go,
  mayMutate,
}: {
  id: string;
  go: AdminRouteGo;
  mayMutate: boolean;
}): JSX.Element {
  const { data, error, reload } = useLoad<AdminAccountDetail>(() => adminApi.account(id), [id]);
  const [live, setLive] = useState<AdminLiveView | null>(null);
  const [pending, setPending] = useState<ActionDef | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      adminApi
        .live(id)
        .then((result) => {
          if (!cancelled) setLive(result);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id]);

  if (error) return <p className="adm-error">{error}</p>;
  if (!data) return <p className="adm-muted">Loading…</p>;

  const account = data.account;
  const rules = data.rules ?? {};
  const available = ACTIONS.filter((action) => action.from.includes(account.status));

  return (
    <div className="adm-page">
      <header className="adm-detail-head">
        <div>
          <h1 className="num">{account.publicId}</h1>
          <p className="adm-dim">
            {account.name} ·{' '}
            <button className="adm-link" onClick={() => go({ name: 'USER', id: data.owner.id })}>
              {data.owner.email}
            </button>{' '}
            · {account.product ? `${account.product.name} v${account.product.version}` : 'no product'}
          </p>
        </div>
        <div className="adm-spacer" />
        <StatusPill status={account.status} />
      </header>

      {failure ? <p className="adm-error">{failure}</p> : null}
      {done ? <p className="adm-note">{done}</p> : null}

      {mayMutate ? (
        <div className="adm-actions" data-testid="admin-actions">
          {available.map((action) => (
            <button
              key={action.id}
              className={`adm-btn ${action.danger ? 'adm-btn-danger' : ''}`}
              onClick={() => {
                setFailure(null);
                setDone(null);
                setPending(action);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="adm-muted">Your role may read this account but not act on it.</p>
      )}

      <Panel
        title="Live"
        action={<span className="adm-dim">{live?.valuation ? 'from the execution engine' : '—'}</span>}
      >
        {live?.valuation ? (
          <div className="adm-stats adm-stats-tight" data-testid="admin-live">
            <Figure label="Balance" micros={live.valuation.balanceMicros} />
            <Figure label="Equity" micros={live.valuation.equityMicros} />
            <Figure label="Open P&L" micros={live.valuation.openPnlMicros} sign />
            <Figure label="Day P&L" micros={live.valuation.dayPnlMicros} sign />
            <Figure label="Realized" micros={live.valuation.realizedPnlMicros} sign />
            <Figure label="Drawdown left" micros={live.valuation.remainingDrawdownMicros} />
            <div className="adm-stat">
              <span className="adm-stat-label">Open contracts</span>
              <span className="adm-stat-value num">{live.valuation.openContracts}</span>
            </div>
            <div className="adm-stat">
              <span className="adm-stat-label">Rule state</span>
              <span className="adm-stat-value">
                {String((live.valuation.rules as { status?: string }).status ?? '—')
                  .replace('_', ' ')
                  .toLowerCase()}
              </span>
            </div>
          </div>
        ) : (
          <p className="adm-muted">No live valuation for this account.</p>
        )}

        <h3 className="adm-sub">Working orders</h3>
        {live && live.workingOrders.length > 0 ? (
          <OrderTable orders={live.workingOrders} />
        ) : (
          <p className="adm-muted">Nothing working.</p>
        )}

        <h3 className="adm-sub">Recent fills</h3>
        {live && live.recentFills.length > 0 ? (
          <table className="adm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Instrument</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Realized</th>
              </tr>
            </thead>
            <tbody>
              {live.recentFills.map((fill) => (
                <tr key={fill.id}>
                  <td className="num adm-dim">{when(fill.execTime)}</td>
                  <td>{fill.symbol}</td>
                  <td>{fill.side}</td>
                  <td className="num">{fill.qty}</td>
                  <td className="num">{fill.price ?? '—'}</td>
                  <td className="num">
                    <Money micros={fill.realizedPnlMicros} sign />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="adm-muted">Nothing filled yet.</p>
        )}
      </Panel>

      <Panel title="Rules in force">
        <dl className="adm-defs">
          <Def label="Starting balance" value={dollars(account.startingBalanceMicros)} />
          <Def label="Profit target" value={dollars(rules['profitTargetMicros'])} />
          <Def label="Max loss" value={dollars(rules['maxLossMicros'])} />
          <Def label="Drawdown type" value={String(rules['drawdownType'] ?? '—')} />
          <Def label="Drawdown floor" value={dollars(account.drawdownFloorMicros)} />
          <Def label="Daily loss limit" value={dollars(rules['dailyLossLimitMicros'])} />
          <Def label="Max contracts" value={String(rules['maxContracts'] ?? '—')} />
          <Def label="Trading days" value={String(account.tradingDaysCount)} />
          <Def label="Activated" value={when(account.activatedAt)} />
          <Def
            label="Instruments"
            value={
              account.instrumentLimits
                ? JSON.stringify(account.instrumentLimits)
                : 'everything the product allows'
            }
          />
        </dl>
        {account.failedReason ? (
          <p className="adm-error">Failed: {account.failedReason}</p>
        ) : null}
      </Panel>

      <Panel title={`Lifecycles (${data.lifecycles.length})`}>
        <table className="adm-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Reason</th>
              <th className="num">Started with</th>
              <th className="num">Ended with</th>
            </tr>
          </thead>
          <tbody>
            {data.lifecycles.map((life) => (
              <tr key={life.id}>
                <td className="num">{life.seq}</td>
                <td className="num adm-dim">{when(life.startedAt)}</td>
                <td className="num adm-dim">{life.endedAt ? when(life.endedAt) : 'current'}</td>
                <td>{life.endReason ?? '—'}</td>
                <td className="num">
                  <Money micros={life.startingBalanceMicros} />
                </td>
                <td className="num">
                  {life.finalBalanceMicros === null ? (
                    '—'
                  ) : (
                    <Money micros={life.finalBalanceMicros} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Orders">
        {data.orders.length > 0 ? <OrderTable orders={data.orders} /> : <p className="adm-muted">None.</p>}
      </Panel>

      <Panel title="Rule violations">
        {data.violations.length === 0 ? (
          <p className="adm-muted">None recorded.</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Rule</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.violations.map((violation) => (
                <tr key={violation.id}>
                  <td className="num adm-dim">{when(violation.at)}</td>
                  <td>{violation.rule}</td>
                  <td>
                    <code>{violation.reasonCode}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Closed trades">
        {data.trades.length === 0 ? (
          <p className="adm-muted">None.</p>
        ) : (
          <table className="adm-table">
            <thead>
              <tr>
                <th>Closed</th>
                <th>Instrument</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {data.trades.map((trade) => (
                <tr key={trade.id}>
                  <td className="num adm-dim">{when(trade.exitTime)}</td>
                  <td>{trade.symbol}</td>
                  <td>{trade.side}</td>
                  <td className="num">{trade.qty}</td>
                  <td className="num">
                    <Money micros={trade.netPnlMicros} sign />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Audit trail">
        <AuditTable entries={data.audit} go={go} />
      </Panel>

      {pending ? (
        <ConfirmAction
          title={pending.title}
          description={pending.description}
          confirmLabel={pending.label}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={(reason) => {
            setBusy(true);
            setFailure(null);
            adminApi
              .action(id, pending.id, reason)
              .then(() => {
                setDone(`${pending.label} done, and recorded in the audit trail.`);
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

function OrderTable({ orders }: { orders: AdminAccountDetail['orders'] }): JSX.Element {
  return (
    <table className="adm-table">
      <thead>
        <tr>
          <th>Placed</th>
          <th>Instrument</th>
          <th>Side</th>
          <th>Type</th>
          <th className="num">Qty</th>
          <th className="num">Limit</th>
          <th className="num">Stop</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <tr key={order.id}>
            <td className="num adm-dim">{when(order.createdAt)}</td>
            <td>{order.symbol}</td>
            <td>{order.side}</td>
            <td>{order.type}</td>
            <td className="num">
              {order.filledQty}/{order.qty}
            </td>
            <td className="num">{order.limitPrice ?? '—'}</td>
            <td className="num">{order.stopPrice ?? '—'}</td>
            <td>
              {order.status}
              {order.rejectReason ? <span className="adm-dim"> · {order.rejectReason}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Figure({
  label,
  micros,
  sign,
}: {
  label: string;
  micros: number;
  sign?: boolean;
}): JSX.Element {
  return (
    <div className="adm-stat">
      <span className="adm-stat-label">{label}</span>
      <span className="adm-stat-value">
        <Money micros={micros} sign={sign} />
      </span>
    </div>
  );
}

function Def({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="adm-def">
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function dollars(micros: unknown): string {
  if (typeof micros !== 'number') return '—';
  return `$${(micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
