import { useState } from 'react';
import { useSession, activeInstrument, selectedAccount } from '../state/session';
import { formatMicros } from '../state/format';
import { Pending } from './Pending';
import { ReplayPanel } from './ReplayPanel';
import { OrderPanel } from './OrderPanel';
import { EnvironmentPanel } from './EnvironmentPanel';
import { DomPanel } from './DomPanel';
import { RiskPanel } from './RiskPanel';
import { PracticePanel } from './PracticePanel';
import './RightPanel.css';
import type { JSX } from 'react';

type RightTab = 'ORDER' | 'DOM' | 'RISK' | 'PRACTICE' | 'REPLAY' | 'ENV';

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
            className={`tab ${tab === 'RISK' ? 'tab-active' : ''}`}
            onClick={() => setTab('RISK')}
            title="Account rules, drawdown and programme progress"
          >
            Risk
          </button>
          <button
            className={`tab ${tab === 'PRACTICE' ? 'tab-active' : ''}`}
            onClick={() => setTab('PRACTICE')}
            title="Training modes, historical sessions and the replay transport"
          >
            Practice
          </button>
          <button
            className={`tab ${tab === 'REPLAY' ? 'tab-active' : ''}`}
            onClick={() => setTab('REPLAY')}
            title="Recording and raw replay controls"
          >
            Replay
          </button>
          <button
            className={`tab ${tab === 'ENV' ? 'tab-active' : ''}`}
            onClick={() => setTab('ENV')}
            title="Simulation environment settings"
          >
            Sim
          </button>
        </div>
        <div className="hdr-spacer" />
        <button className="icon-btn" onClick={onCollapse} title="Collapse panel">
          ›
        </button>
      </div>

      <div className="panel-body">
        {tab === 'ORDER' ? <OrderPanel /> : null}
        {tab === 'DOM' ? <DomPanel /> : null}
        {tab === 'RISK' ? <RiskPanel /> : null}
        {tab === 'PRACTICE' ? <PracticePanel /> : null}
        {tab === 'REPLAY' ? <ReplayPanel /> : null}
        {tab === 'ENV' ? <EnvironmentPanel /> : null}
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
