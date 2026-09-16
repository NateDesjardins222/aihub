import { useState } from 'react';
import { useSession } from '../state/session';
import { formatMicros, pnlClass } from '../state/format';
import type { ApiInstrument } from '../api/types';
import { Pending } from './Pending';
import type { JSX } from 'react';

type ActivityTab = 'POSITIONS' | 'ORDERS' | 'TRADES' | 'ACCOUNTS' | 'QUOTES';

const TABS: ActivityTab[] = ['POSITIONS', 'ORDERS', 'TRADES', 'ACCOUNTS', 'QUOTES'];

/**
 * Bottom activity panel.
 *
 * The Accounts tab is real today: it renders the authoritative account rows the
 * server returned. The other tabs are wired to the same table chrome and fill in
 * as the engine that owns each one lands.
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
  const [tab, setTab] = useState<ActivityTab>('ACCOUNTS');
  const accounts = useSession((s) => s.accounts);

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
              {t === 'ACCOUNTS' ? <span className="tab-count">{accounts.length}</span> : null}
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
          {tab === 'ACCOUNTS' ? <AccountsTable /> : null}
          {tab === 'POSITIONS' ? (
            <Pending title="Positions" milestone="Milestone 5">
              Server-authoritative positions with weighted average entry, mark price and live
              unrealized P&L.
            </Pending>
          ) : null}
          {tab === 'ORDERS' ? (
            <Pending title="Working orders" milestone="Milestone 5">
              One shared order object, rendered here, on the chart and in the DOM.
            </Pending>
          ) : null}
          {tab === 'TRADES' ? (
            <Pending title="Closed trades" milestone="Milestone 5">
              Completed round-trips with gross P&L, fees and net P&L.
            </Pending>
          ) : null}
          {tab === 'QUOTES' ? (
            <Pending title="Quotes" milestone="Milestone 2">
              Top-of-book and last trade for each subscribed instrument, stamped with the
              exchange timestamp and its measured delay.
              {instrument ? ` Currently watching ${instrument.root}.` : ''}
            </Pending>
          ) : null}
        </div>
      )}
    </>
  );
}

function AccountsTable(): JSX.Element {
  const accounts = useSession((s) => s.accounts);
  const selectedId = useSession((s) => s.selectedAccountId);
  const selectAccount = useSession((s) => s.selectAccount);

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Account</th>
          <th>Type</th>
          <th>Status</th>
          <th className="right">Balance</th>
          <th className="right">Day P&L</th>
          <th className="right">Open P&L</th>
          <th className="right">Drawdown left</th>
          <th>Drawdown type</th>
          <th className="right">Profit target</th>
          <th className="right">Max contracts</th>
          <th className="right">Days</th>
        </tr>
      </thead>
      <tbody>
        {accounts.length === 0 ? (
          <tr className="empty-row">
            <td colSpan={11}>No accounts.</td>
          </tr>
        ) : (
          accounts.map((a) => (
            <tr
              key={a.id}
              onClick={() => selectAccount(a.id)}
              style={{ background: a.id === selectedId ? 'var(--bg-active)' : undefined }}
            >
              <td>{a.name}</td>
              <td>{a.accountType}</td>
              <td>{a.status}</td>
              <td className="right num">{formatMicros(a.balanceMicros)}</td>
              <td className={`right num ${pnlClass(a.dayPnlMicros)}`}>
                {formatMicros(a.dayPnlMicros, { sign: true })}
              </td>
              <td className={`right num ${pnlClass(a.openPnlMicros)}`}>
                {formatMicros(a.openPnlMicros, { sign: true })}
              </td>
              <td className="right num">{formatMicros(a.remainingDrawdownMicros)}</td>
              <td>{a.ruleTemplate.drawdownType.replace(/_/g, ' ')}</td>
              <td className="right num">
                {formatMicros(a.profitTargetProgressMicros, { sign: true })} /{' '}
                {formatMicros(a.ruleTemplate.profitTargetMicros)}
              </td>
              <td className="right num">{a.ruleTemplate.maxContracts}</td>
              <td className="right num">
                {a.tradingDaysCount}/{a.ruleTemplate.minTradingDays}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
