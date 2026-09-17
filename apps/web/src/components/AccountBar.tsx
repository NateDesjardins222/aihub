/**
 * The account bar.
 *
 * Account, money, rule headroom, the session, and the navigation to everything
 * secondary. Every figure in it is a server-computed value rendered as text;
 * the bar derives nothing.
 *
 * It is one row, 30px tall, and it is the only chrome above the chart.
 */
import { useEffect, type JSX } from 'react';
import { useSession, selectedAccount, activeInstrument } from '../state/session';
import { formatCompactMicros, formatMicros, pnlClass } from '../state/format';
import { useClock } from './usePersistentSize';
import { useFreshness } from '../market/useFreshness';
import { useTrading } from '../trading/store';
import { useWorkspace } from '../state/workspace';
import { useChartStore } from '../state/chart-store';
import { useReplayStatus, useReplayStatusPolling } from '../state/replay-status';
import { timeFormatter } from '../chart/appearance';
import { MASK, useTraining } from '../state/training';
import { Icon } from '../ui/Icon';
import './AccountBar.css';

export function AccountBar({
  onToggleRail,
  railOpen,
}: {
  onToggleRail: () => void;
  railOpen: boolean;
}): JSX.Element {
  const accounts = useSession((s) => s.accounts);
  const account = useSession(selectedAccount);
  const instrument = useSession(activeInstrument);
  const selectAccount = useSession((s) => s.selectAccount);
  const signOut = useSession((s) => s.signOut);
  const now = useClock();
  const freshness = useFreshness(instrument?.root ?? null);

  // Live account figures, all computed server-side and pushed here.
  const pnl = useTrading((s) => s.pnl);
  const rules = useTrading((s) => s.rules);
  const attach = useTrading((s) => s.attach);

  const surface = useWorkspace((s) => s.surface);
  const openSurface = useWorkspace((s) => s.openSurface);
  const openSettings = useWorkspace((s) => s.openSettings);
  const appearance = useChartStore((s) => s.appearance);
  const replay = useReplayStatus((s) => s);
  // The bar is always mounted, so it is what keeps the mode current: the badge
  // must be right whether or not the practice drawer is open.
  useReplayStatusPolling();

  // Training modes hide information; they never change it.
  const visibility = useTraining((s) => s.visibility);

  useEffect(() => {
    if (account) attach(account.id);
  }, [account, attach]);

  const exchangeZone = instrument?.sessionTimezone ?? 'America/Chicago';
  const marketState = instrument?.marketState.state ?? 'CLOSED';
  const money = (render: () => string): string => (visibility.balance ? render() : MASK);
  const result = (render: () => string): string => (visibility.pnl ? render() : MASK);

  return (
    <header className="abar">
      <button
        className={`abar-icon ${railOpen ? '' : 'abar-icon-off'}`}
        onClick={onToggleRail}
        title={railOpen ? 'Hide the drawing tools' : 'Show the drawing tools'}
        aria-label="Toggle drawing tools"
      >
        <Icon name="trend" size={13} />
      </button>

      <div className="abar-brand">
        <span className="abar-mark" aria-hidden="true" />
        <span className="abar-word">ATLAS</span>
        <span className="abar-sim" title="Every order is simulated. Nothing is routed to an exchange.">
          SIM
        </span>
      </div>

      <select
        className="abar-account"
        value={account?.id ?? ''}
        onChange={(event) => selectAccount(event.target.value)}
        aria-label="Account"
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>

      {rules ? <Pill text={rules.status.replace('_', ' ')} tone={statusTone(rules.status)} /> : null}

      <Metric
        label="BAL"
        value={money(() =>
          pnl ? formatCompactMicros(pnl.balanceMicros) : account ? formatCompactMicros(account.balanceMicros) : '—',
        )}
        title="Settled cash: starting balance plus realized P&L, less fees"
      />
      <Metric
        label="EQ"
        value={money(() =>
          rules ? formatCompactMicros(rules.equityMicros) : pnl ? formatCompactMicros(pnl.equityMicros) : '—',
        )}
        title="Balance plus open P&L"
      />
      <Metric
        label="DAY"
        value={result(() => (rules ? formatMicros(rules.dayPnlMicros, { sign: true }) : '—'))}
        tone={rules && visibility.pnl ? pnlClass(rules.dayPnlMicros) : 'flat'}
        title="Equity change since this trading day opened"
      />
      <Metric
        label="OPEN"
        value={result(() => (rules ? formatMicros(rules.openPnlMicros, { sign: true }) : '—'))}
        tone={rules && visibility.pnl ? pnlClass(rules.openPnlMicros) : 'flat'}
      />
      {visibility.rules && rules ? (
        <Metric
          label="DD LEFT"
          value={formatCompactMicros(Math.max(0, rules.remainingDrawdownMicros))}
          tone={rules.remainingDrawdownMicros <= 0 ? 'neg' : 'flat'}
          title="Room left before the drawdown floor"
        />
      ) : null}
      {visibility.rules && rules && rules.remainingDailyLossMicros !== null ? (
        <Metric
          label="DLL LEFT"
          value={formatCompactMicros(Math.max(0, rules.remainingDailyLossMicros))}
          title="Loss allowed before trading stops for the day"
        />
      ) : null}
      {/*
        A practice account's "target" is a placeholder large enough never to be
        reached, so showing progress towards it is noise. Programme accounts
        have a real one and show it.
      */}
      {visibility.rules &&
      rules &&
      rules.profitTargetMicros > 0 &&
      account?.accountType !== 'PRACTICE' ? (
        <Metric
          label="TARGET"
          value={`${formatCompactMicros(rules.profitProgressMicros)} / ${formatCompactMicros(rules.profitTargetMicros)}`}
          tone={rules.profitTargetMet ? 'pos' : 'flat'}
        />
      ) : null}

      <div className="hdr-spacer" />

      {replay.isReplay ? (
        <Pill text={replay.replayPaused ? 'REPLAY PAUSED' : 'REPLAY'} tone="warn" />
      ) : null}

      <span className="abar-session">
        <span className="num abar-clock">
          {visibility.dateTime
            ? timeFormatter(appearance, exchangeZone, { seconds: true }).format(now)
            : MASK}
        </span>
        <Pill text={marketState} tone={marketState === 'OPEN' ? 'ok' : 'bad'} />
        {freshness && freshness.state !== 'FRESH' ? (
          <Pill text={freshness.state.replace('_', ' ')} tone="warn" />
        ) : (
          <Pill text="DELAYED" tone="neutral" />
        )}
      </span>

      <nav className="abar-nav" aria-label="Sections">
        <button
          className={`abar-icon ${surface === 'PRACTICE' ? 'abar-icon-on' : ''}`}
          onClick={() => openSurface('PRACTICE')}
          title="Practice, historical sessions and the replay transport"
          aria-label="Practice"
        >
          <Icon name="practice" size={13} />
        </button>
        <button
          className={`abar-icon ${surface === 'JOURNAL' ? 'abar-icon-on' : ''}`}
          onClick={() => openSurface('JOURNAL')}
          title="Journal and analytics"
          aria-label="Journal"
          disabled={!visibility.journal}
        >
          <Icon name="journal" size={13} />
        </button>
        <button
          className={`abar-icon ${surface === 'LADDER' ? 'abar-icon-on' : ''}`}
          onClick={() => openSurface('LADDER')}
          title="Price ladder"
          aria-label="Price ladder"
        >
          <Icon name="ladder" size={13} />
        </button>
        <button
          className="abar-icon"
          onClick={() => openSettings('SYMBOL')}
          title="Settings"
          aria-label="Settings"
        >
          <Icon name="gear" size={13} />
        </button>
      </nav>

      <button className="abar-user" onClick={() => void signOut()} title="Sign out">
        <Icon name="close" size={11} />
      </button>
    </header>
  );
}

function statusTone(status: string): string {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'PASSED' || status === 'GOAL_REACHED') return 'good';
  if (status === 'FAILED') return 'bad';
  return 'warn';
}

function Metric({
  label,
  value,
  tone = 'flat',
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}): JSX.Element {
  return (
    <div className="abar-metric" title={title}>
      <span className="abar-metric-label">{label}</span>
      <span className={`num abar-metric-value ${tone}`}>{value}</span>
    </div>
  );
}

function Pill({ text, tone }: { text: string; tone: string }): JSX.Element {
  return <span className={`abar-pill abar-pill-${tone}`}>{text}</span>;
}
