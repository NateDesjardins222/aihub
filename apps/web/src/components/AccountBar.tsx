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
import { formatMicros } from '../state/format';
import { useClock } from './usePersistentSize';
import { useFreshness } from '../market/useFreshness';
import { useStreamHealth } from '../market/useStreamHealth';
import { useTrading } from '../trading/store';
import { useWorkspace } from '../state/workspace';
import { useChartStore } from '../state/chart-store';
import { useReplayStatus, useReplayStatusPolling } from '../state/replay-status';
import { timeFormatter } from '../chart/appearance';
import { MASK, useTraining } from '../state/training';
import { Icon } from '../ui/Icon';
import { LayoutMenu } from './LayoutMenu';
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
  const now = useClock();
  const freshness = useFreshness(instrument?.root ?? null);
  const stream = useStreamHealth();

  // Live account figures, all computed server-side and pushed here.
  const pnl = useTrading((s) => s.pnl);
  const rules = useTrading((s) => s.rules);
  const attach = useTrading((s) => s.attach);

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

      {/*
        A locked account that is STILL EXPOSED must say so — never a bare
        "locked" while a position remains open. The engine reports the truth:
        PENDING means the breach's flatten has not confirmed flat yet (a closed
        or stale feed can leave the liquidation waiting), so the trader knows a
        position is still live and being closed, not that they are safely flat.
      */}
      {pnl?.liquidation === 'PENDING' ? <Pill text="FLATTENING" tone="warn" /> : null}

      {/*
        Said out loud, not hidden behind dashes.

        When a position cannot be priced - the platform is serving a practice
        recording while the position was opened on the live feed - every P&L
        figure here reads as unknown. A trader seeing dashes deserves to know
        why, and what to do about it.
      */}
      {pnl && pnl.marked === false ? (
        <span
          className="abar-unpriced"
          data-testid="unpriced-warning"
          title={
            pnl.unmarkable.length > 0
              ? pnl.unmarkable
                  .map(
                    (p) =>
                      `${p.symbol} was opened against ${p.openedAgainst}; the platform is serving ${p.nowServing}. Switch back to that market to manage it.`,
                  )
                  .join(' ')
              : 'This account cannot be priced right now, so its P&L is unknown.'
          }
        >
          NOT PRICED
        </span>
      ) : null}

      {/*
        FOUR BOXES, AND ONLY FOUR.
        ==========================
        The brief removed EQ, DAY, OPEN, DD LEFT, DLL LEFT and TARGET from the
        primary bar. What is left is what a trader checks between decisions:
        what the account is worth settled, the line it must not cross, what it
        has made, and what it is making right now.

        Nothing is derived here. RP&L is NET - gross realized less fees -
        because that is the number for which BAL equals the starting balance
        plus RP&L, and a bar whose own figures do not add up is worse than a
        bar with fewer of them.

        The removed figures are not gone from the platform: equity, day P&L,
        drawdown headroom, the daily loss limit and target progress are all in
        the Accounts blotter and in Risk and programme, which is where a trader
        goes to study the account rather than to glance at it.
      */}
      <MoneyBox
        label="BAL"
        value={money(() =>
          pnl
            ? formatMicros(pnl.balanceMicros)
            : account
              ? formatMicros(account.balanceMicros)
              : '—',
        )}
        title="Settled cash: starting balance plus realized P&L, less fees"
      />
      {/*
        A floor at or below zero is not a limit.
        ======================================
        A practice template with a maximum loss larger than the account puts
        the floor below zero - this database has $100,000 accounts whose floor
        computes to -$50,000 - and printing "MLL -$50,000.00" states a limit
        that cannot be reached as though it were one. The honest rendering is a
        dash that says why, and the server's start-up audit reports the
        configuration itself.
      */}
      <MoneyBox
        label="MLL"
        value={money(() => {
          const floor = rules?.drawdownFloorMicros ?? pnl?.drawdownFloorMicros ?? null;
          if (floor === null) return '—';
          return floor > 0 ? formatMicros(floor) : '—';
        })}
        title={
          (rules?.drawdownFloorMicros ?? pnl?.drawdownFloorMicros ?? 0) > 0
            ? 'Maximum loss limit: the balance this account may not fall below'
            : 'This account has no reachable loss limit: its maximum loss is larger than the account itself.'
        }
      />
      <MoneyBox
        label="RP&L"
        value={result(() =>
          pnl ? formatMicros(pnl.realizedPnlMicros - pnl.feesMicros, { sign: true }) : '—',
        )}
        tone={pnl && visibility.pnl ? boxTone(pnl.realizedPnlMicros - pnl.feesMicros) : 'flat'}
        title="Realized P&L, net of fees, since this account opened"
      />
      <MoneyBox
        label="UP&L"
        value={result(() =>
          pnl && pnl.openPnlMicros !== null ? formatMicros(pnl.openPnlMicros, { sign: true }) : '—',
        )}
        tone={
          pnl && pnl.openPnlMicros !== null && visibility.pnl ? boxTone(pnl.openPnlMicros) : 'flat'
        }
        title="Open P&L on the positions held right now"
      />

      <div className="hdr-spacer" />

      {replay.isReplay ? (
        <Pill
          text={replay.replayPaused ? 'REPLAY PAUSED' : 'REPLAY'}
          tone="warn"
          testId="replay-pill"
        />
      ) : null}

      <span className="abar-session">
        <span className="num abar-clock">
          {visibility.dateTime
            ? timeFormatter(appearance, exchangeZone, { seconds: true }).format(now)
            : MASK}
        </span>
        {/*
          The socket, when it is not there.

          A dropped stream is the one failure a trader cannot see for
          themselves: the chart keeps its last candle, the numbers keep their
          last value, and everything looks fine until it matters. So it is
          said plainly, once, in the place the feed is already described - and
          only after the drop has outlived the reconnect that usually fixes it
          within half a second.
        */}
        {stream.down ? (
          <Pill text="RECONNECTING" tone="bad" testId="stream-down" />
        ) : null}
        <Pill text={marketState} tone={marketState === 'OPEN' ? 'ok' : 'bad'} />
        {/*
          The feed's state, unless it is the session's state said twice.

          Out of hours the bar read "CLOSED  MARKET CLOSED" - two pills, one
          fact. The feed pill is for what the SESSION does not already
          explain: a feed that has gone stale or silent while the market is
          open, which is the case a trader has to know about.
        */}
        {freshness && freshness.state !== 'FRESH' ? (
          freshness.state === 'MARKET_CLOSED' && marketState !== 'OPEN' ? null : (
            <Pill text={freshness.state.replace('_', ' ')} tone="warn" />
          )
        ) : (
          <Pill text="DELAYED" tone="neutral" />
        )}
      </span>

      {/*
        Practice, Journal, Settings and Sign out have moved to the application
        rail on the far left, which is where application navigation belongs.
        What stays here is the CHART's own layout control, because how many
        charts there are is a property of this workspace rather than a place to
        navigate to - and Settings, because a trader adjusting the chart should
        not have to travel to the other side of the window to do it.
      */}
      <nav className="abar-nav" aria-label="Chart layout">
        <LayoutMenu />
        <button
          className="abar-icon"
          onClick={() => openSettings('SYMBOL')}
          title="Settings"
          aria-label="Settings"
        >
          <Icon name="gear" size={13} />
        </button>
      </nav>
    </header>
  );
}

function statusTone(status: string): string {
  if (status === 'ACTIVE') return 'ok';
  if (status === 'PASSED' || status === 'GOAL_REACHED') return 'good';
  if (status === 'FAILED') return 'bad';
  return 'warn';
}

/**
 * Which way a filled box leans.
 *
 * Zero is neutral, not green. "+$0.00 in green" reads as a win that has not
 * happened.
 */
function boxTone(micros: number): 'pos' | 'neg' | 'flat' {
  if (micros > 0) return 'pos';
  if (micros < 0) return 'neg';
  return 'flat';
}

/**
 * One of the four primary account figures.
 *
 * A filled rectangle, substantial enough to be read at a glance from across a
 * desk, with the label above the number. White type throughout: on a green or
 * red fill the colour IS the sign, and tinting the text as well leaves it
 * harder to read for no extra information.
 */
function MoneyBox({
  label,
  value,
  tone = 'flat',
  title,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg' | 'flat';
  title?: string;
}): JSX.Element {
  return (
    <div
      className={`abar-box abar-box-${tone}`}
      title={title}
      data-testid={`account-box-${label.toLowerCase().replace(/[^a-z]/g, '')}`}
      data-tone={tone}
    >
      {/*
        ONE GROUP, CENTRED - not two spans each finding their own way.

        The label and the figure are different sizes in different faces, so
        aligning them individually inside the box left the pair sitting low
        and slightly differently in each of the four boxes. They are now a
        single baseline-aligned group, and it is that GROUP the box centres.
      */}
      <span className="abar-box-inner">
        <span className="abar-box-label">{label}</span>
        <span className="num abar-box-value">{value}</span>
      </span>
    </div>
  );
}

function Pill({
  text,
  tone,
  testId,
}: {
  text: string;
  tone: string;
  testId?: string;
}): JSX.Element {
  return (
    <span className={`abar-pill abar-pill-${tone}`} data-testid={testId}>
      {text}
    </span>
  );
}
