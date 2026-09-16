import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { useSession, selectedAccount } from '../state/session';
import { formatMicros, pnlClass } from '../state/format';
import { useTrading } from '../trading/store';
import { tradingApi } from '../trading/api';
import type { ApiInstrument } from '../api/types';
import { Pending } from './Pending';

type ActivityTab = 'POSITIONS' | 'ORDERS' | 'TRADES' | 'ACCOUNTS' | 'QUOTES';

const TABS: ActivityTab[] = ['POSITIONS', 'ORDERS', 'TRADES', 'ACCOUNTS', 'QUOTES'];

/**
 * Bottom activity panel.
 *
 * Positions, orders and trades are the account's authoritative state, read from
 * the server. Nothing here is derived locally beyond formatting.
 */
export function ActivityPanel({
  collapsed,
  onToggle,
  instrument,
}: {
  collapsed: boolean;
  onToggle: () => void;
  instrument: ApiInstrument | null;
}): JSX.Element {
  const [tab, setTab] = useState<ActivityTab>('POSITIONS');
  const accounts = useSession((s) => s.accounts);
  // Select the raw arrays and derive here. A selector that returns
  // `s.positions.filter(...)` hands zustand a NEW array on every call, so the
  // store always compares as changed and the component re-renders forever.
  const allPositions = useTrading((s) => s.positions);
  const allOrders = useTrading((s) => s.orders);
  const trades = useTrading((s) => s.trades);

  const positions = useMemo(() => allPositions.filter((p) => p.qty !== 0), [allPositions]);
  const open = useMemo(
    () =>
      allOrders.filter(
        (o) =>
          o.status === 'WORKING' || o.status === 'PARTIALLY_FILLED' || o.status === 'CANCEL_PENDING',
      ),
    [allOrders],
  );

  const counts: Partial<Record<ActivityTab, number>> = {
    POSITIONS: positions.length,
    ORDERS: open.length,
    TRADES: trades.length,
    ACCOUNTS: accounts.length,
  };

  return (
    <>
      <div className="panel-head">
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={`tab ${tab === t && !collapsed ? 'tab-active' : ''}`}
              onClick={() => {
                setTab(t);
                if (collapsed) onToggle();
              }}
            >
              {t.charAt(0) + t.slice(1).toLowerCase()}
              {counts[t] ? <span className="tab-count">{counts[t]}</span> : null}
            </button>
          ))}
        </div>
        <div className="hdr-spacer" />
        <button className="icon-btn" onClick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▲' : '▼'}
        </button>
      </div>

      {collapsed ? null : (
        <div className="panel-body">
          {tab === 'POSITIONS' ? <PositionsTable /> : null}
          {tab === 'ORDERS' ? <OrdersTable /> : null}
          {tab === 'TRADES' ? <TradesTable /> : null}
          {tab === 'ACCOUNTS' ? <AccountsTable /> : null}
          {tab === 'QUOTES' ? (
            <Pending title="Quotes" milestone="Milestone 9">
              A watchlist of top-of-book and last trade across every subscribed instrument.
              {instrument ? ` Currently watching ${instrument.root}.` : ''}
            </Pending>
          ) : null}
        </div>
      )}
    </>
  );
}

function PositionsTable(): JSX.Element {
  const account = useSession(selectedAccount);
  const allPositions = useTrading((s) => s.positions);
  const positions = useMemo(() => allPositions.filter((p) => p.qty !== 0), [allPositions]);
  const instruments = useSession((s) => s.instruments);
  const refresh = useTrading((s) => s.refresh);

  const precisionOf = (symbol: string): number =>
    instruments.find((i) => i.root === symbol)?.pricePrecision ?? 2;

  const close = async (symbol: string): Promise<void> => {
    if (!account) return;
    await tradingApi.flatten(account.id, symbol);
    await refresh();
  };

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Side</th>
          <th className="right">Qty</th>
          <th className="right">Avg price</th>
          <th className="right">Current</th>
          <th className="right">Open P&L</th>
          <th className="right">Realized</th>
          <th className="right">Fees</th>
          <th>Stop</th>
          <th>Target</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {positions.length === 0 ? (
          <tr className="empty-row">
            <td colSpan={11}>No open positions.</td>
          </tr>
        ) : (
          positions.map((p) => {
            const precision = precisionOf(p.symbol);
            return (
              <tr key={p.symbol}>
                <td>{p.symbol}</td>
                <td className={p.side === 'LONG' ? 'pos' : 'neg'}>{p.side}</td>
                <td className="right num">{p.qty}</td>
                <td className="right num">{p.avgEntryPrice?.toFixed(precision) ?? '—'}</td>
                <td className="right num">{p.markPrice?.toFixed(precision) ?? '—'}</td>
                <td className={`right num ${pnlClass(p.unrealizedPnlMicros)}`}>
                  {formatMicros(p.unrealizedPnlMicros, { sign: true })}
                </td>
                <td className={`right num ${pnlClass(p.realizedPnlMicros)}`}>
                  {formatMicros(p.realizedPnlMicros, { sign: true })}
                </td>
                <td className="right num">{formatMicros(p.feesMicros)}</td>
                <td className="num">{p.stopOrderId ? '●' : '—'}</td>
                <td className="num">{p.targetOrderId ? '●' : '—'}</td>
                <td>
                  <button className="row-action" onClick={() => void close(p.symbol)}>
                    Close
                  </button>
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function OrdersTable(): JSX.Element {
  const account = useSession(selectedAccount);
  const orders = useTrading((s) => s.orders);
  const refresh = useTrading((s) => s.refresh);
  const instruments = useSession((s) => s.instruments);

  const precisionOf = (symbol: string): number =>
    instruments.find((i) => i.root === symbol)?.pricePrecision ?? 2;

  const cancel = async (orderId: string): Promise<void> => {
    if (!account) return;
    await tradingApi.cancel(account.id, orderId);
    await refresh();
  };

  const isOpen = (status: string): boolean =>
    status === 'WORKING' || status === 'PARTIALLY_FILLED' || status === 'CANCEL_PENDING';

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Side</th>
          <th className="right">Qty</th>
          <th>Type</th>
          <th className="right">Price</th>
          <th>Status</th>
          <th className="right">Filled</th>
          <th className="right">Remaining</th>
          <th className="right">Avg fill</th>
          <th>Role</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {orders.length === 0 ? (
          <tr className="empty-row">
            <td colSpan={12}>No orders yet.</td>
          </tr>
        ) : (
          orders.map((o) => {
            const precision = precisionOf(o.symbol);
            const price = o.limitPrice ?? o.stopPrice;
            return (
              <tr key={o.id}>
                <td className="num">{new Date(o.createdAt).toLocaleTimeString('en-US', { hour12: false })}</td>
                <td>{o.symbol}</td>
                <td className={o.side === 'BUY' ? 'pos' : 'neg'}>{o.side}</td>
                <td className="right num">{o.qty}</td>
                <td>{o.type.replace('_', ' ')}</td>
                <td className="right num">{price === null ? 'MKT' : price.toFixed(precision)}</td>
                <td title={o.rejectReason ?? undefined}>{o.status.replace('_', ' ')}</td>
                <td className="right num">{o.filledQty}</td>
                <td className="right num">{o.remainingQty}</td>
                <td className="right num">{o.avgFillPrice?.toFixed(precision) ?? '—'}</td>
                <td>{o.bracketRole === 'STANDALONE' ? '—' : o.bracketRole.replace('_', ' ')}</td>
                <td>
                  {isOpen(o.status) ? (
                    <button className="row-action" onClick={() => void cancel(o.id)}>
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function TradesTable(): JSX.Element {
  const trades = useTrading((s) => s.trades);
  const instruments = useSession((s) => s.instruments);
  const precisionOf = (symbol: string): number =>
    instruments.find((i) => i.root === symbol)?.pricePrecision ?? 2;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Entry time</th>
          <th>Exit time</th>
          <th>Symbol</th>
          <th>Side</th>
          <th className="right">Qty</th>
          <th className="right">Entry</th>
          <th className="right">Exit</th>
          <th className="right">Gross P&L</th>
          <th className="right">Fees</th>
          <th className="right">Net P&L</th>
        </tr>
      </thead>
      <tbody>
        {trades.length === 0 ? (
          <tr className="empty-row">
            <td colSpan={10}>No closed trades yet.</td>
          </tr>
        ) : (
          trades.map((t) => {
            const precision = precisionOf(t.symbol);
            const fmt = (ms: number): string =>
              new Date(ms).toLocaleTimeString('en-US', { hour12: false });
            return (
              <tr key={t.id}>
                <td className="num">{fmt(t.entryTime)}</td>
                <td className="num">{fmt(t.exitTime)}</td>
                <td>{t.symbol}</td>
                <td className={t.side === 'LONG' ? 'pos' : 'neg'}>{t.side}</td>
                <td className="right num">{t.qty}</td>
                <td className="right num">{t.entryPrice.toFixed(precision)}</td>
                <td className="right num">{t.exitPrice.toFixed(precision)}</td>
                <td className={`right num ${pnlClass(t.grossPnlMicros)}`}>
                  {formatMicros(t.grossPnlMicros, { sign: true })}
                </td>
                <td className="right num">{formatMicros(t.feesMicros)}</td>
                <td className={`right num ${pnlClass(t.netPnlMicros)}`}>
                  {formatMicros(t.netPnlMicros, { sign: true })}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

function AccountsTable(): JSX.Element {
  const accounts = useSession((s) => s.accounts);
  const selectedId = useSession((s) => s.selectedAccountId);
  const selectAccount = useSession((s) => s.selectAccount);
  const pnl = useTrading((s) => s.pnl);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Type</th>
          <th>Status</th>
          <th className="right">Balance</th>
          <th className="right">Equity</th>
          <th className="right">Day P&L</th>
          <th className="right">Open P&L</th>
          <th className="right">Drawdown left</th>
          <th>Drawdown type</th>
          <th className="right">Profit target</th>
          <th className="right">Contracts</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map((a) => {
          const live = pnl && pnl.accountId === a.id ? pnl : null;
          const balance = live?.balanceMicros ?? a.balanceMicros;
          const equity = live?.equityMicros ?? a.equityMicros;
          const dayPnl = live?.dayPnlMicros ?? a.dayPnlMicros;
          const openPnl = live?.openPnlMicros ?? 0;
          return (
            <tr
              key={a.id}
              onClick={() => selectAccount(a.id)}
              style={{ background: a.id === selectedId ? 'var(--bg-active)' : undefined }}
            >
              <td>{a.name}</td>
              <td>{a.accountType}</td>
              <td>{live?.status ?? a.status}</td>
              <td className="right num">{formatMicros(balance)}</td>
              <td className="right num">{formatMicros(equity)}</td>
              <td className={`right num ${pnlClass(dayPnl)}`}>
                {formatMicros(dayPnl, { sign: true })}
              </td>
              <td className={`right num ${pnlClass(openPnl)}`}>
                {formatMicros(openPnl, { sign: true })}
              </td>
              <td className="right num">
                {formatMicros(live?.remainingDrawdownMicros ?? a.remainingDrawdownMicros)}
              </td>
              <td>{a.ruleTemplate.drawdownType.replace(/_/g, ' ')}</td>
              <td className="right num">
                {formatMicros(live?.profitTargetProgressMicros ?? a.profitTargetProgressMicros, {
                  sign: true,
                })}{' '}
                / {formatMicros(a.ruleTemplate.profitTargetMicros)}
              </td>
              <td className="right num">
                {live?.openContracts ?? 0}/{a.ruleTemplate.maxContracts}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
