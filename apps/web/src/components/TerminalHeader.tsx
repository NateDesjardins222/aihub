import { useEffect } from 'react';
import { useSession, selectedAccount, activeInstrument } from '../state/session';
import { formatClock, formatMicros, pnlClass } from '../state/format';
import { useClock } from './usePersistentSize';
import { FeedBadge } from '../panels/FeedBadge';
import { useFreshness } from '../market/useFreshness';
import { useTrading } from '../trading/store';
import type { JSX } from 'react';

/**
 * Top header: account, balance, day P&L, open P&L, drawdown, connection.
 *
 * Every figure here is rendered from a server-computed value. Open P&L and the
 * live connection state become real in Milestones 5 and 2 respectively; until
 * then they are labelled rather than filled with plausible-looking numbers.
 */
export function TerminalHeader(): JSX.Element {
  const accounts = useSession((s) => s.accounts);
  const account = useSession(selectedAccount);
  const instrument = useSession(activeInstrument);
  const selectAccount = useSession((s) => s.selectAccount);
  const signOut = useSession((s) => s.signOut);
  const user = useSession((s) => s.user);
  const now = useClock();
  const freshness = useFreshness(instrument?.root ?? null);
  // Live account figures. Every one is computed server-side and pushed here;
  // the header derives nothing of its own.
  const pnl = useTrading((s) => s.pnl);
  const attach = useTrading((s) => s.attach);

  useEffect(() => {
    if (account) attach(account.id);
  }, [account, attach]);

  const tz = instrument?.sessionTimezone ?? 'America/Chicago';
  const marketState = instrument?.marketState.state ?? 'CLOSED';

  return (
    <header className="terminal-header">
      <div className="hdr-brand">
        <div className="hdr-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="hdr-wordmark">ATLAS</span>
        <span className="hdr-sim" title="Every order is simulated. Nothing is routed to an exchange.">
          SIM
        </span>
      </div>

      <div className="hdr-group">
        <span className="label">Account</span>
        <select
          value={account?.id ?? ''}
          onChange={(e) => selectAccount(e.target.value)}
          className="hdr-account-select"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {account ? <StatusPill status={account.status} /> : null}
      </div>

      <Metric
        label="Balance"
        value={pnl ? formatMicros(pnl.balanceMicros) : account ? formatMicros(account.balanceMicros) : '—'}
        title="Settled cash: starting balance plus realized P&L, less fees"
      />
      <Metric
        label="Equity"
        value={pnl ? formatMicros(pnl.equityMicros) : '—'}
        title="Balance plus open P&L"
      />
      <Metric
        label="Day P&L"
        value={pnl ? formatMicros(pnl.dayPnlMicros, { sign: true }) : '—'}
        tone={pnl ? pnlClass(pnl.dayPnlMicros) : 'flat'}
      />
      <Metric
        label="Open P&L"
        value={pnl ? formatMicros(pnl.openPnlMicros, { sign: true }) : '—'}
        tone={pnl ? pnlClass(pnl.openPnlMicros) : 'flat'}
      />
      <Metric
        label="Drawdown left"
        value={pnl ? formatMicros(pnl.remainingDrawdownMicros) : '—'}
        tone={
          pnl && account && pnl.remainingDrawdownMicros < account.ruleTemplate.maxLossMicros * 0.25
            ? 'neg'
            : 'flat'
        }
        title={account ? `${account.ruleTemplate.drawdownType.replace(/_/g, ' ')} drawdown` : undefined}
      />
      <Metric
        label="Target"
        value={
          pnl
            ? `${formatMicros(pnl.profitTargetProgressMicros, { sign: true })} / ${formatMicros(pnl.profitTargetMicros)}`
            : '—'
        }
      />

      <div className="hdr-spacer" />

      <div className="hdr-group hdr-session">
        <span className="label">{instrument?.exchange ?? 'CME'}</span>
        <span className="num hdr-clock">{formatClock(now, tz)}</span>
        <MarketPill state={marketState} reason={instrument?.marketState.reason ?? null} />
      </div>

      <div className="hdr-group">
        <FeedBadge freshness={freshness} />
      </div>

      <button className="hdr-user" onClick={() => void signOut()} title="Sign out">
        {user?.displayName ?? 'Sign out'}
      </button>
    </header>
  );
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
    <div className="hdr-metric" title={title}>
      <span className="label">{label}</span>
      <span className={`num hdr-metric-value ${tone}`}>{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const tone =
    status === 'ACTIVE'
      ? 'ok'
      : status === 'PASSED' || status === 'GOAL_REACHED'
        ? 'good'
        : status === 'FAILED'
          ? 'bad'
          : 'warn';
  return <span className={`pill pill-${tone}`}>{status.replace('_', ' ')}</span>;
}

function MarketPill({ state, reason }: { state: string; reason: string | null }): JSX.Element {
  const tone = state === 'OPEN' ? 'ok' : state === 'MAINTENANCE' ? 'warn' : 'bad';
  return (
    <span className={`pill pill-${tone}`} title={reason ?? undefined}>
      {state}
    </span>
  );
}
