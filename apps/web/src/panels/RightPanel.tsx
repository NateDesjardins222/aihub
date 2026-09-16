import { useState } from 'react';
import { useSession, activeInstrument, selectedAccount } from '../state/session';
import { formatMicros } from '../state/format';
import { Pending } from './Pending';
import { ReplayPanel } from './ReplayPanel';
import { DomPanel } from './DomPanel';
import './RightPanel.css';
import type { JSX } from 'react';

type RightTab = 'ORDER' | 'DOM' | 'REPLAY';

/** Right column: order entry and the price ladder, switchable. */
export function RightPanel({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  const [tab, setTab] = useState<RightTab>('ORDER');
  const instrument = useSession(activeInstrument);
  const account = useSession(selectedAccount);

  return (
    <>
      <div className="panel-head">
        <div className="tabs">
          <button
            className={`tab ${tab === 'ORDER' ? 'tab-active' : ''}`}
            onClick={() => setTab('ORDER')}
          >
            Order
          </button>
          <button className={`tab ${tab === 'DOM' ? 'tab-active' : ''}`} onClick={() => setTab('DOM')}>
            DOM
          </button>
          <button
            className={`tab ${tab === 'REPLAY' ? 'tab-active' : ''}`}
            onClick={() => setTab('REPLAY')}
          >
            Replay
          </button>
        </div>
        <div className="hdr-spacer" />
        <button className="icon-btn" onClick={onCollapse} title="Collapse panel">
          ›
        </button>
      </div>

      <div className="panel-body">
        {tab === 'ORDER' ? <OrderPanelPreview /> : null}
        {tab === 'DOM' ? <DomPanel /> : null}
        {tab === 'REPLAY' ? <ReplayPanel /> : null}
      </div>

      {instrument && account ? (
        <footer className="right-footer">
          <div className="rf-row">
            <span className="label">Contract</span>
            <span className="num">{instrument.activeContract.code}</span>
          </div>
          <div className="rf-row">
            <span className="label">Max contracts</span>
            <span className="num">{account.ruleTemplate.maxContracts}</span>
          </div>
          <div className="rf-row">
            <span className="label">Round turn</span>
            <span className="num">
              {formatMicros(
                2 * (instrument.commissionPerSideMicros + instrument.exchangeFeesPerSideMicros),
              )}
            </span>
          </div>
        </footer>
      ) : null}
    </>
  );
}

/**
 * The order ticket's layout, rendered with real instrument values but with
 * submission disabled: the execution engine lands in Milestone 5, and a BUY
 * button that does nothing is exactly what this project must not ship.
 */
function OrderPanelPreview(): JSX.Element {
  const instrument = useSession(activeInstrument);
  if (!instrument) return <Pending title="No instrument selected" milestone="—" />;

  return (
    <div className="order-panel">
      <div className="op-notice">
        <span className="pending-tag">Milestone 5 / 6</span>
        <p>
          Order submission is disabled until the server-side simulation engine is live. The
          controls below are laid out against real {instrument.root} specifications and become
          active the moment the engine accepts orders.
        </p>
      </div>

      <div className="op-grid">
        <label>
          <span className="label">Quantity</span>
          <input className="num" type="number" defaultValue={1} min={instrument.minOrderQty} disabled />
        </label>
        <label>
          <span className="label">Order type</span>
          <select disabled>
            {instrument.supportedOrderTypes.map((t) => (
              <option key={t}>{t.replace('_', ' ')}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Limit price</span>
          <input className="num" type="text" placeholder={`× ${instrument.tickSize}`} disabled />
        </label>
        <label>
          <span className="label">Stop price</span>
          <input className="num" type="text" placeholder={`× ${instrument.tickSize}`} disabled />
        </label>
      </div>

      <div className="op-bracket">
        <span className="label">Bracket</span>
        <div className="op-bracket-row">
          <span>Stop loss</span>
          <input className="num" type="number" placeholder="ticks" disabled />
          <span>Take profit</span>
          <input className="num" type="number" placeholder="ticks" disabled />
        </div>
      </div>

      <div className="op-actions">
        <button className="op-buy" disabled>
          BUY MKT
        </button>
        <button className="op-sell" disabled>
          SELL MKT
        </button>
      </div>
      <div className="op-actions op-actions-secondary">
        <button disabled>Flatten</button>
        <button disabled>Reverse</button>
        <button disabled>Cancel all</button>
      </div>
    </div>
  );
}
