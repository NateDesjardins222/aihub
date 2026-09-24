import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import { type Analytics, Card, Metric, money, Money, msg, pct, Skeleton, tone } from '../lib';

interface Trade {
  id: string; symbol: string; contractCode: string | null; side: string; qty: number;
  entryTimeMs: number | null; exitTimeMs: number | null; grossPnlMicros: number; feesMicros: number; netPnlMicros: number; tradeDate: string;
}

type Range = '1D' | '7D' | '30D' | '90D' | 'ALL';
const RANGES: Range[] = ['1D', '7D', '30D', '90D', 'ALL'];

function rangeToDates(r: Range): { from: string | null; to: string | null } {
  if (r === 'ALL') return { from: null, to: null };
  const days = r === '1D' ? 1 : r === '7D' ? 7 : r === '30D' ? 30 : 90;
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export function Performance({ accountId }: { accountId: string }): JSX.Element {
  const [range, setRange] = useState<Range>('30D');
  const [an, setAn] = useState<Analytics | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);

  const load = useCallback(() => {
    setAn(null); setTrades(null); setDay(null);
    const { from, to } = rangeToDates(range);
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    void api.get<Analytics>(`/api/v1/portal/accounts/${accountId}/analytics${suffix}`).then(setAn).catch((e: unknown) => setErr(msg(e)));
    void api.get<{ trades: Trade[] }>(`/api/v1/portal/accounts/${accountId}/trades${suffix}`).then((r) => setTrades(r.trades)).catch(() => setTrades([]));
  }, [accountId, range]);
  useEffect(load, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, { net: number; count: number }>();
    for (const t of trades ?? []) {
      const e = m.get(t.tradeDate) ?? { net: 0, count: 0 };
      e.net += t.netPnlMicros; e.count += 1; m.set(t.tradeDate, e);
    }
    return m;
  }, [trades]);

  if (err) return <p className="pt-error">{err}</p>;

  return (
    <>
      <div className="pt-chart-range" data-testid="pt-range">
        {RANGES.map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}
      </div>

      <Card>
        {!an ? <Skeleton h={220} /> : an.equity.points.length < 2 ? (
          <p className="pt-note">Not enough closed trades in this range to draw a curve.</p>
        ) : (
          <EquityCurve points={an.equity.points} />
        )}
        <p className="pt-note">Cumulative net P&amp;L over closed trades (fees included). Payout debits and resets are not trades and never appear here.</p>
      </Card>

      {an && (
        <>
          <div className="pt-section-title">Performance</div>
          <div className="pt-metrics">
            <Metric label="Net P&L" value={<Money micros={an.trades.netPnlMicros} sign />} />
            <Metric label="Win rate" value={pct(an.trades.winRate)} />
            <Metric label="Profit factor" value={an.trades.profitFactor == null ? '—' : an.trades.profitFactor.toFixed(2)} />
            <Metric label="Expectancy" value={<Money micros={an.trades.expectancyMicros} />} />
            <Metric label="Trades" value={String(an.trades.totalTrades)} />
            <Metric label="Avg win" value={<Money micros={an.trades.averageWinMicros} />} />
            <Metric label="Avg loss" value={<Money micros={an.trades.averageLossMicros} />} />
            <Metric label="Avg R" value={an.trades.averageRMultiple == null ? 'n/a' : `${an.trades.averageRMultiple.toFixed(2)}R`} cls={an.trades.averageRMultiple == null ? 'na' : ''} />
            <Metric label="Best day" value={<Money micros={an.days.bestDayMicros} />} />
            <Metric label="Worst day" value={<Money micros={an.days.worstDayMicros} />} />
            <Metric label="Max drawdown" value={<Money micros={-an.equity.maxDrawdownMicros} />} />
            <Metric label="Best streak" value={String(an.streaks.bestWinStreak)} cls="pos" />
          </div>
        </>
      )}

      <div className="pt-section-title">P&amp;L calendar</div>
      {!trades ? <Skeleton h={160} /> : byDay.size === 0 ? (
        <div className="pt-empty">No trading days in this range.</div>
      ) : (
        <Card><PnlCalendar byDay={byDay} onDay={setDay} selected={day} /></Card>
      )}

      {day && (
        <>
          <div className="pt-section-title">Trades on {day}</div>
          <Card pad={false}>
            <table className="pt-table" data-testid="pt-day-trades">
              <thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th>Qty</th><th>Gross</th><th>Fees</th><th>Net</th></tr></thead>
              <tbody>
                {(trades ?? []).filter((t) => t.tradeDate === day).map((t) => (
                  <tr key={t.id}>
                    <td>{t.exitTimeMs ? new Date(t.exitTimeMs).toLocaleTimeString() : '—'}</td>
                    <td>{t.contractCode ?? t.symbol}</td>
                    <td className={t.side === 'LONG' ? 'pos' : 'neg'}>{t.side}</td>
                    <td>{t.qty}</td>
                    <td><Money micros={t.grossPnlMicros} /></td>
                    <td className="num">{money(-t.feesMicros)}</td>
                    <td><Money micros={t.netPnlMicros} sign /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {an && an.breakdowns.byInstrument.length > 0 && (
        <>
          <div className="pt-section-title">By instrument</div>
          <Card pad={false}>
            <table className="pt-table">
              <thead><tr><th>Instrument</th><th>Trades</th><th>Net P&L</th><th>Win rate</th></tr></thead>
              <tbody>{an.breakdowns.byInstrument.map((b) => (<tr key={b.key}><td>{b.key}</td><td>{b.trades}</td><td><Money micros={b.netPnlMicros} /></td><td className="num">{pct(b.winRate)}</td></tr>))}</tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}

function EquityCurve({ points }: { points: Array<{ tExitMs: number; equityMicros: number; drawdownMicros: number }> }): JSX.Element {
  const W = 900, H = 220, pad = 8;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const ys = points.map((p) => p.equityMicros);
  const min = Math.min(...ys), max = Math.max(...ys);
  const range = max - min || 1;
  const x = (i: number): number => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v: number): number => H - pad - ((v - min) / range) * (H - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equityMicros).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const zeroY = min <= 0 && max >= 0 ? y(0) : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const svg = ref.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((rel - pad) / (W - pad * 2)) * (points.length - 1))));
    setHover(i);
  };
  const hp = hover != null ? points[hover] : null;

  return (
    <div className="pt-equity-wrap" data-testid="pt-equity">
      <svg ref={ref} className="pt-equity" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Trading equity curve"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs><linearGradient id="ptgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--pt-chrome)" stopOpacity="0.22" /><stop offset="100%" stopColor="var(--pt-chrome)" stopOpacity="0" /></linearGradient></defs>
        {zeroY != null && <path className="zero" d={`M0,${zeroY.toFixed(1)} L${W},${zeroY.toFixed(1)}`} />}
        <path className="area" d={area} />
        <path className="line" d={line} />
        {hp && hover != null && (
          <>
            <path className="cross" d={`M${x(hover).toFixed(1)},0 L${x(hover).toFixed(1)},${H}`} />
            <circle className="dot" cx={x(hover)} cy={y(hp.equityMicros)} r={3} />
          </>
        )}
      </svg>
      {hp && (
        <div className="pt-tooltip" style={{ left: `min(${(hover! / (points.length - 1)) * 100}%, calc(100% - 150px))`, top: 8 }}>
          <div className="tt-row"><span className="tt-k">Date</span><span>{new Date(hp.tExitMs).toLocaleDateString()}</span></div>
          <div className="tt-row"><span className="tt-k">Equity</span><span className={`num ${tone(hp.equityMicros)}`}>{money(hp.equityMicros, { sign: true })}</span></div>
          <div className="tt-row"><span className="tt-k">Drawdown</span><span className="num">{money(-hp.drawdownMicros)}</span></div>
        </div>
      )}
    </div>
  );
}

function PnlCalendar({ byDay, onDay, selected }: { byDay: Map<string, { net: number; count: number }>; onDay: (d: string) => void; selected: string | null }): JSX.Element {
  const dates = [...byDay.keys()].sort();
  if (dates.length === 0) return <p className="pt-note">No days.</p>;
  // Build a contiguous week-aligned grid from the first to the last trading day.
  const first = new Date(`${dates[0]}T00:00:00`);
  const last = new Date(`${dates[dates.length - 1]}T00:00:00`);
  const start = new Date(first); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday-align
  const cells: Array<{ date: string | null }> = [];
  for (let d = new Date(start); d <= last; d.setDate(d.getDate() + 1)) {
    cells.push({ date: d.toISOString().slice(0, 10) });
  }
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <div>
      <div className="pt-cal" data-testid="pt-calendar">
        {DOW.map((d) => <div key={d} className="pt-cal-dow">{d}</div>)}
        {cells.map((c, i) => {
          const info = c.date ? byDay.get(c.date) : undefined;
          const cls = !info ? '' : info.net > 0 ? 'pos' : info.net < 0 ? 'neg' : '';
          const day = c.date ? Number(c.date.slice(8, 10)) : '';
          return (
            <div key={i} className={`pt-cal-cell ${cls}${info ? ' clickable' : ''}${selected === c.date ? ' on' : ''}`}
              onClick={info && c.date ? () => onDay(c.date!) : undefined}>
              <span className="cal-d">{day}</span>
              {info && <><span className={`cal-p ${tone(info.net)}`}>{money(info.net, { sign: true })}</span><span className="cal-n">{info.count} trade{info.count === 1 ? '' : 's'}</span></>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
