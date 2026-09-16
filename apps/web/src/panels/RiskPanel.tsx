/**
 * The account dashboard.
 *
 * Everything here is the server's arithmetic, arriving on the valuation stream:
 * equity, day P&L, how much drawdown is left and how far through the programme
 * the account is. The browser formats it and nothing else - a risk figure a
 * client computed for itself is a risk figure that disagrees with the one that
 * will actually fail you.
 */
import { useMemo, useState, type JSX } from 'react';
import { useTrading } from '../trading/store';
import { tradingApi, type ApiRuleConfig, type ApiRuleStatus } from '../trading/api';
import './RiskPanel.css';

const DOLLARS = 1_000_000;

function money(micros: number, signed = false): string {
  const dollars = micros / DOLLARS;
  const sign = signed && dollars > 0 ? '+' : dollars < 0 ? '−' : '';
  return `${sign}$${Math.abs(dollars).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function compact(micros: number): string {
  const dollars = Math.abs(micros / DOLLARS);
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}k`;
  return `$${dollars.toFixed(0)}`;
}

function toneFor(status: ApiRuleStatus['status']): string {
  switch (status) {
    case 'FAILED':
      return 'bad';
    case 'LOCKED':
      return 'warn';
    case 'PASSED':
    case 'GOAL_REACHED':
      return 'ok';
    default:
      return 'neutral';
  }
}

function Bar({
  value,
  limit,
  tone,
  title,
}: {
  value: number;
  limit: number;
  tone: string;
  title: string;
}): JSX.Element {
  const pct = limit <= 0 ? 0 : Math.max(0, Math.min(100, (value / limit) * 100));
  return (
    <div className="risk-bar" title={title}>
      <div className={`risk-bar-fill risk-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function RiskPanel(): JSX.Element {
  const rules = useTrading((s) => s.rules);
  const ruleBook = useTrading((s) => s.ruleBook);
  const pnl = useTrading((s) => s.pnl);
  const positions = useTrading((s) => s.positions);
  const accountId = useTrading((s) => s.accountId);
  const refresh = useTrading((s) => s.refresh);
  const loadRules = useTrading((s) => s.loadRules);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = async (): Promise<void> => {
    if (!accountId) return;
    setBusy(true);
    try {
      await tradingApi.resetAccount(accountId);
      await loadRules();
      await refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const config: ApiRuleConfig | null = ruleBook?.config ?? null;

  const openContracts = useMemo(
    () => positions.reduce((sum, p) => sum + Math.abs(p.qty), 0),
    [positions],
  );

  if (!rules || !config) {
    return <div className="risk-panel risk-empty">Loading account rules…</div>;
  }

  const tone = toneFor(rules.status);
  const drawdownUsed = Math.max(0, rules.highWaterMarkMicros - rules.equityMicros);
  const drawdownRoom = Math.max(0, rules.remainingDrawdownMicros);
  const dailyLimit = rules.dailyLossLimitMicros;
  const dailyUsed = dailyLimit === null ? 0 : Math.max(0, -rules.dayPnlMicros);

  // Contracts you may still add. The server enforces it; this is the same
  // number so the trader is never told they have room the engine will refuse.
  const contractsLeft = Math.max(0, config.maxContracts - openContracts);

  return (
    <div className="risk-panel">
      <div className={`risk-status risk-${tone}`}>
        <span className="risk-status-dot" />
        <span className="risk-status-text">
          {rules.status === 'GOAL_REACHED' ? 'TARGET REACHED' : rules.status}
        </span>
        <span className="risk-status-note">
          {rules.breach
            ? rules.breach.message
            : ruleBook?.templateName ?? 'Practice account'}
        </span>
      </div>

      <div className="risk-grid">
        <div className="risk-cell">
          <span className="risk-label">Equity</span>
          <span className="num risk-value">{money(rules.equityMicros)}</span>
        </div>
        <div className="risk-cell">
          <span className="risk-label">Balance</span>
          <span className="num risk-value">{money(rules.balanceMicros)}</span>
        </div>
        <div className="risk-cell">
          <span className="risk-label">Open P&amp;L</span>
          <span className={`num risk-value ${rules.openPnlMicros >= 0 ? 'up' : 'down'}`}>
            {money(rules.openPnlMicros, true)}
          </span>
        </div>
        <div className="risk-cell">
          <span className="risk-label">Day P&amp;L</span>
          <span className={`num risk-value ${rules.dayPnlMicros >= 0 ? 'up' : 'down'}`}>
            {money(rules.dayPnlMicros, true)}
          </span>
        </div>
        <div className="risk-cell">
          <span className="risk-label">Realized</span>
          <span className={`num risk-value ${rules.dayRealizedPnlMicros >= 0 ? 'up' : 'down'}`}>
            {money(rules.dayRealizedPnlMicros, true)}
          </span>
        </div>
        <div className="risk-cell">
          <span className="risk-label">Fees today</span>
          <span className="num risk-value">{money(pnl?.feesMicros ?? 0)}</span>
        </div>
      </div>

      <section className="risk-block">
        <header>
          <h4>Drawdown</h4>
          <span className="risk-tag">{config.drawdownType.replace('_', ' ').toLowerCase()}</span>
        </header>
        <div className="risk-row">
          <span className="risk-label">Remaining</span>
          <span className={`num risk-big ${drawdownRoom <= 0 ? 'down' : ''}`}>
            {money(drawdownRoom)}
          </span>
        </div>
        <Bar
          value={drawdownUsed}
          limit={config.maxLossMicros}
          tone={drawdownRoom <= config.maxLossMicros * 0.25 ? 'bad' : 'ok'}
          title={`${money(drawdownUsed)} of ${money(config.maxLossMicros)} used`}
        />
        <div className="risk-foot">
          <span>
            floor <b className="num">{money(rules.drawdownFloorMicros)}</b>
          </span>
          <span>
            high water <b className="num">{money(rules.highWaterMarkMicros)}</b>
          </span>
        </div>
      </section>

      {dailyLimit !== null ? (
        <section className="risk-block">
          <header>
            <h4>Daily loss limit</h4>
            <span className="risk-tag">
              {config.dailyLossPolicy === 'FAIL' ? 'breach fails account' : 'breach locks the day'}
            </span>
          </header>
          <div className="risk-row">
            <span className="risk-label">Remaining</span>
            <span
              className={`num risk-big ${(rules.remainingDailyLossMicros ?? 0) <= 0 ? 'down' : ''}`}
            >
              {money(Math.max(0, rules.remainingDailyLossMicros ?? 0))}
            </span>
          </div>
          <Bar
            value={dailyUsed}
            limit={dailyLimit}
            tone={(rules.remainingDailyLossMicros ?? 0) <= dailyLimit * 0.25 ? 'bad' : 'ok'}
            title={`${money(dailyUsed)} of ${money(dailyLimit)} used today`}
          />
        </section>
      ) : null}

      {config.profitTargetMicros > 0 ? (
        <section className="risk-block">
          <header>
            <h4>Profit target</h4>
            <span className="risk-tag">
              {compact(rules.profitProgressMicros)} / {compact(config.profitTargetMicros)}
            </span>
          </header>
          <Bar
            value={Math.max(0, rules.profitProgressMicros)}
            limit={config.profitTargetMicros}
            tone={rules.profitTargetMet ? 'ok' : 'accent'}
            title={`${money(rules.profitProgressMicros)} of ${money(config.profitTargetMicros)}`}
          />
        </section>
      ) : null}

      {rules.requirements.length > 0 ? (
        <section className="risk-block">
          <header>
            <h4>To pass</h4>
          </header>
          <ul className="risk-reqs">
            {rules.requirements.map((req) => (
              <li key={req.key} className={req.met ? 'met' : ''}>
                <span className="risk-req-mark">{req.met ? '✓' : '○'}</span>
                <span className="risk-req-label">{req.label}</span>
                <span className="num risk-req-value">
                  {req.unit === 'MICROS'
                    ? `${compact(req.current)} / ${compact(req.required)}`
                    : req.unit === 'RATIO'
                      ? `${(req.current * 100).toFixed(0)}% / ${(req.required * 100).toFixed(0)}%`
                      : `${req.current} / ${req.required}`}
                </span>
              </li>
            ))}
          </ul>
          {rules.consistency && !rules.consistency.passing ? (
            <p className="risk-note">
              Best day is {money(rules.consistency.bestDayProfitMicros)}. Another{' '}
              {money(rules.consistency.additionalProfitNeededMicros)} made on other days brings it
              inside the {(rules.consistency.threshold * 100).toFixed(0)}% limit.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="risk-block">
        <header>
          <h4>Position limit</h4>
          <span className="risk-tag">
            {openContracts} / {config.maxContracts} contracts
          </span>
        </header>
        <Bar
          value={openContracts}
          limit={config.maxContracts}
          tone={contractsLeft === 0 ? 'bad' : 'ok'}
          title={`${contractsLeft} more contracts allowed`}
        />
        <div className="risk-foot">
          <span>
            days traded <b className="num">{rules.tradingDaysCount}</b>
          </span>
          <span>
            winning <b className="num">{rules.winningDaysCount}</b>
          </span>
          {ruleBook?.account.currentTradeDate ? (
            <span>
              session <b className="num">{ruleBook.account.currentTradeDate}</b>
            </span>
          ) : null}
        </div>
      </section>

      {rules.status === 'FAILED' || rules.status === 'PASSED' ? (
        <section className="risk-block risk-reset">
          <header>
            <h4>Programme over</h4>
          </header>
          <p className="risk-note">
            {rules.status === 'FAILED'
              ? 'A breached account cannot be revived - that is what a breach means. Starting again clears the balance, the drawdown anchor, the day counters and the trade history.'
              : 'This programme is complete. Starting again clears the balance, the drawdown anchor, the day counters and the trade history.'}
          </p>
          {confirming ? (
            <div className="risk-row">
              <button className="chip" disabled={busy} onClick={() => void reset()}>
                Yes, start again
              </button>
              <button className="chip" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="chip" onClick={() => setConfirming(true)}>
              Start the programme again
            </button>
          )}
        </section>
      ) : null}

      {ruleBook && ruleBook.days.length > 0 ? (
        <section className="risk-block">
          <header>
            <h4>Recent days</h4>
          </header>
          <ul className="risk-days">
            {ruleBook.days.slice(0, 8).map((day) => (
              <li key={day.tradeDate}>
                <span className="risk-day-date">{day.tradeDate}</span>
                <span className={`num ${day.realizedPnlMicros >= 0 ? 'up' : 'down'}`}>
                  {money(day.realizedPnlMicros, true)}
                </span>
                <span className="risk-day-flag">{day.counted ? 'counted' : '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
