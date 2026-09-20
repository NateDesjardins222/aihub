/**
 * Firm-wide trading surveillance.
 *
 * Open positions, working orders and recent fills across every account in the
 * organisation - the operator's window into what Atlas's own accounts are
 * doing right now. Every figure comes from the server; positions are valued by
 * the engine, never re-derived here. Clicking a row leads to the account.
 */
import { useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Money, Panel, useLoad, when, type AdminRouteGo } from '../shared';
import type { AdminTrading } from '../types';

const TABS = ['Positions', 'Working orders', 'Recent fills'] as const;
type Tab = (typeof TABS)[number];

function price(value: number | null): string {
  return value === null ? '—' : value.toLocaleString(undefined, { minimumFractionDigits: 2 });
}

export function AdminTradingPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const [tab, setTab] = useState<Tab>('Positions');
  const [term, setTerm] = useState('');
  const { data, error, loading } = useLoad<AdminTrading>(() => adminApi.trading(), []);

  const needle = term.trim().toLowerCase();
  const match = (...fields: Array<string | null | undefined>): boolean =>
    needle.length === 0 || fields.some((f) => (f ?? '').toLowerCase().includes(needle));

  return (
    <div className="adm-page">
      <Panel
        title="Trading"
        action={
          <div className="adm-search">
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Filter by trader, account or symbol"
              aria-label="Filter trading"
            />
          </div>
        }
      >
        <div className="adm-tabs" role="tablist">
          {TABS.map((name) => (
            <button
              key={name}
              role="tab"
              aria-selected={tab === name}
              className={`adm-tab ${tab === name ? 'adm-tab-on' : ''}`}
              onClick={() => setTab(name)}
            >
              {name}
              {name === 'Positions' && data ? (
                <span className="adm-tab-count">{data.openPositions.length}</span>
              ) : null}
              {name === 'Working orders' && data ? (
                <span className="adm-tab-count">{data.workingOrders.length}</span>
              ) : null}
            </button>
          ))}
        </div>

        {error ? <p className="adm-error">Unable to load — {error}</p> : null}
        {!data && loading ? <p className="adm-muted">Loading…</p> : null}

        {data && tab === 'Positions' ? (
          <table className="adm-table" data-testid="admin-positions">
            <thead>
              <tr>
                <th>Trader</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Avg entry</th>
                <th className="num">Mark</th>
                <th className="num">Unrealized</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {data.openPositions
                .filter((p) => match(p.trader, p.accountPublicId, p.symbol))
                .map((p) => (
                  <tr
                    key={`${p.accountId}-${p.symbol}`}
                    className="adm-row-click"
                    onClick={() => go({ name: 'ACCOUNT', id: p.accountId })}
                  >
                    <td>{p.trader ?? '—'}</td>
                    <td className="num adm-dim">{p.accountPublicId ?? '—'}</td>
                    <td>{p.symbol}</td>
                    <td className={p.side === 'LONG' ? 'adm-pos' : 'adm-neg'}>{p.side}</td>
                    <td className="num">{p.qty}</td>
                    <td className="num">{price(p.avgEntryPrice)}</td>
                    <td className="num">{price(p.markPrice)}</td>
                    <td className="num">
                      {p.unrealizedPnlMicros === null ? '—' : <Money micros={p.unrealizedPnlMicros} sign />}
                    </td>
                    <td className="num adm-dim">{when(p.openedAt)}</td>
                  </tr>
                ))}
              {data.openPositions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="adm-muted">
                    No open positions across the firm.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {data && tab === 'Working orders' ? (
          <table className="adm-table" data-testid="admin-working-orders">
            <thead>
              <tr>
                <th>Trader</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Type</th>
                <th className="num">Qty</th>
                <th className="num">Limit</th>
                <th className="num">Stop</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.workingOrders
                .filter((o) => match(o.trader, o.accountPublicId, o.symbol))
                .map((o) => (
                  <tr
                    key={o.id}
                    className="adm-row-click"
                    onClick={() => go({ name: 'ACCOUNT', id: o.accountId })}
                  >
                    <td>{o.trader}</td>
                    <td className="num adm-dim">{o.accountPublicId}</td>
                    <td>{o.symbol}</td>
                    <td className={o.side === 'BUY' ? 'adm-pos' : 'adm-neg'}>{o.side}</td>
                    <td className="adm-dim">{o.type}</td>
                    <td className="num">{o.qty}</td>
                    <td className="num">{price(o.limitPrice)}</td>
                    <td className="num">{price(o.stopPrice)}</td>
                    <td className="adm-dim">{o.status.replace('_', ' ').toLowerCase()}</td>
                    <td className="num adm-dim">{when(o.createdAt)}</td>
                  </tr>
                ))}
              {data.workingOrders.length === 0 ? (
                <tr>
                  <td colSpan={10} className="adm-muted">
                    Nothing working.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}

        {data && tab === 'Recent fills' ? (
          <table className="adm-table" data-testid="admin-fills">
            <thead>
              <tr>
                <th>Time</th>
                <th>Trader</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Side</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Realized</th>
                <th className="num">Fees</th>
              </tr>
            </thead>
            <tbody>
              {data.recentFills
                .filter((f) => match(f.trader, f.accountPublicId, f.symbol))
                .map((f) => (
                  <tr
                    key={f.id}
                    className="adm-row-click"
                    onClick={() => go({ name: 'ACCOUNT', id: f.accountId })}
                  >
                    <td className="num adm-dim">{when(f.execTime)}</td>
                    <td>{f.trader}</td>
                    <td className="num adm-dim">{f.accountPublicId}</td>
                    <td>{f.symbol}</td>
                    <td className={f.side === 'BUY' ? 'adm-pos' : 'adm-neg'}>{f.side}</td>
                    <td className="num">{f.qty}</td>
                    <td className="num">{price(f.price)}</td>
                    <td className="num">
                      {f.realizedPnlMicros === 0 ? '—' : <Money micros={f.realizedPnlMicros} sign />}
                    </td>
                    <td className="num adm-dim">
                      {f.feesMicros == null ? '—' : <Money micros={-Math.abs(f.feesMicros)} />}
                    </td>
                  </tr>
                ))}
              {data.recentFills.length === 0 ? (
                <tr>
                  <td colSpan={9} className="adm-muted">
                    No fills yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  );
}
