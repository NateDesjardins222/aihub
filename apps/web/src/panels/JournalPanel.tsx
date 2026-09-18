/**
 * The journal.
 *
 * Four views over the same records: what the account has done overall, which
 * days it did it on, the individual trades with the trader's own words on them,
 * and the sessions they were taken in.
 *
 * Every figure is computed by the server from the stored trades. The browser
 * formats and nothing else - a journal that recomputed its own statistics would
 * eventually disagree with the trades it is supposed to be summarizing.
 */
import { Fragment, useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useTrading } from '../trading/store';
import { useTraining, MASK } from '../state/training';
import {
  journalApi,
  type ApiAnalytics,
  type ApiJournalTrade,
  type ApiPracticeSession,
  type ApiSessionReview,
  type ApiStats,
  type ApiTag,
} from '../trading/journal-api';
import { formatMicros } from '../state/format';
import { useSession } from '../state/session';
import './JournalPanel.css';

type JournalTab = 'OVERVIEW' | 'CALENDAR' | 'TRADES' | 'SESSIONS';

const DOLLARS = 1_000_000;

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function ratio(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits);
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function JournalPanel(): JSX.Element {
  const accountId = useTrading((s) => s.accountId);
  const visibility = useTraining((s) => s.visibility);
  const [tab, setTab] = useState<JournalTab>('OVERVIEW');
  /** A day picked from the calendar: the trades list then shows that day only. */
  const [dayFilter, setDayFilter] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<ApiAnalytics | null>(null);
  const [trades, setTrades] = useState<ApiJournalTrade[]>([]);
  const [tags, setTags] = useState<ApiTag[]>([]);
  const [sessions, setSessions] = useState<ApiPracticeSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [review, setReview] = useState<ApiSessionReview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [a, t, g, s] = await Promise.all([
        journalApi.analytics(accountId),
        journalApi.trades(accountId, { limit: 500 }),
        journalApi.tags(),
        journalApi.sessions(accountId),
      ]);
      setAnalytics(a);
      setTrades(t.trades);
      setTags(g.tags);
      setSessions(s.sessions);
    } catch {
      /* the empty state explains itself */
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openSession = useCallback(async (id: string) => {
    setSelected(id);
    try {
      const result = await journalApi.session(id);
      setReview(result.review);
    } catch {
      setReview(null);
    }
  }, []);

  // Results are hidden while a mode says so; the journal is still being kept.
  if (!visibility.journal) {
    return (
      <div className="journal-panel journal-empty">
        This training mode hides the journal while you trade. Every trade is still being recorded,
        and the review will be here when the session ends.
      </div>
    );
  }

  return (
    <div className="journal-panel">
      <div className="journal-tabs">
        {(
          [
            ['OVERVIEW', 'Overview'],
            ['CALENDAR', 'Calendar'],
            ['TRADES', 'Trades'],
            ['SESSIONS', 'Sessions'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`chip ${tab === id ? 'chip-on' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <button className="chip journal-refresh" onClick={() => void load()} disabled={loading}>
          ↻
        </button>
      </div>

      {tab === 'OVERVIEW' ? <Overview analytics={analytics} masked={!visibility.pnl} /> : null}
      {tab === 'CALENDAR' ? (
        <Calendar
          analytics={analytics}
          masked={!visibility.pnl}
          onPickDay={(tradeDate) => {
            // A day on the calendar is a question - "what did I do on the
            // 17th?" - so it opens the trades of that day rather than just
            // colouring a square.
            setDayFilter(tradeDate);
            setTab('TRADES');
          }}
        />
      ) : null}
      {tab === 'TRADES' ? (
        <Trades
          trades={dayFilter ? trades.filter((trade) => trade.tradeDate === dayFilter) : trades}
          tags={tags}
          masked={!visibility.tradeResults}
          onChanged={load}
          onTagsChanged={(next) => setTags(next)}
          day={dayFilter}
          onClearDay={() => setDayFilter(null)}
        />
      ) : null}
      {tab === 'SESSIONS' ? (
        <Sessions
          sessions={sessions}
          selected={selected}
          review={review}
          onOpen={openSession}
          masked={!visibility.pnl}
        />
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------- overview ---

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
  title?: string;
}): JSX.Element {
  return (
    <div className="journal-stat" title={title}>
      <span className="journal-stat-label">{label}</span>
      <span className={`num journal-stat-value ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function Overview({
  analytics,
  masked,
}: {
  analytics: ApiAnalytics | null;
  masked: boolean;
}): JSX.Element {
  if (!analytics) return <div className="journal-empty">No trades recorded yet.</div>;
  const s: ApiStats = analytics.stats;
  if (s.trades === 0) return <div className="journal-empty">No trades recorded yet.</div>;

  const money = (micros: number | null, signed = false): string =>
    masked ? MASK : micros === null ? '—' : formatMicros(micros, { sign: signed });

  return (
    <div className="journal-body">
      <EquityCurve analytics={analytics} masked={masked} />

      <div className="journal-stats">
        <Stat label="Trades" value={String(s.trades)} />
        <Stat
          label="Win rate"
          value={pct(s.winRate)}
          title={`${s.wins} won, ${s.losses} lost, ${s.scratches} scratched`}
        />
        <Stat
          label="Net P&L"
          value={money(s.netPnlMicros, true)}
          tone={s.netPnlMicros >= 0 ? 'up' : 'down'}
        />
        <Stat
          label="Profit factor"
          value={ratio(s.profitFactor)}
          title="Gross profit divided by gross loss. Undefined until something has been lost."
        />
        <Stat label="Expectancy" value={money(s.expectancyMicros, true)} title="Average net result per trade" />
        <Stat
          label="Expectancy R"
          value={ratio(s.expectancyR)}
          title={`Over the ${s.ratedTrades} trades taken with a stop`}
        />
        <Stat label="Avg winner" value={money(s.avgWinMicros)} tone="up" />
        <Stat label="Avg loser" value={money(s.avgLossMicros)} tone="down" />
        <Stat label="Largest winner" value={money(s.largestWinMicros)} tone="up" />
        <Stat label="Largest loser" value={money(s.largestLossMicros)} tone="down" />
        <Stat
          label="Max drawdown"
          value={money(analytics.curve.maxDrawdownMicros)}
          tone="down"
          title="Deepest fall from a peak of realized equity"
        />
        <Stat label="Fees" value={money(s.feesMicros)} />
        <Stat label="Avg hold" value={duration(s.avgHoldMs)} />
        <Stat label="Avg win hold" value={duration(s.avgWinHoldMs)} />
        <Stat label="Avg loss hold" value={duration(s.avgLossHoldMs)} />
        <Stat label="Avg MAE" value={money(s.avgMaeMicros)} tone="down" title="How far the average trade went against you" />
        <Stat label="Avg MFE" value={money(s.avgMfeMicros)} tone="up" title="How far the average trade went for you" />
        <Stat
          label="Capture"
          value={pct(s.captureRatio)}
          title="How much of a winner's best excursion was kept"
        />
        <Stat label="Win streak" value={String(s.streaks.longestWins)} />
        <Stat label="Loss streak" value={String(s.streaks.longestLosses)} />
        <Stat label="Contracts" value={String(s.contracts)} />
      </div>

      <Breakdown title="By instrument" buckets={analytics.breakdowns.bySymbol} masked={masked} />
      <Breakdown title="Long vs short" buckets={analytics.breakdowns.bySide} masked={masked} />
      <Breakdown title="By hour" buckets={analytics.breakdowns.byHour} masked={masked} />
      <Breakdown title="By weekday" buckets={analytics.breakdowns.byWeekday} masked={masked} />
    </div>
  );
}

function Breakdown({
  title,
  buckets,
  masked,
}: {
  title: string;
  buckets: ApiAnalytics['breakdowns']['bySymbol'];
  masked: boolean;
}): JSX.Element | null {
  if (buckets.length === 0) return null;
  const peak = Math.max(...buckets.map((b) => Math.abs(b.netPnlMicros)), 1);

  return (
    <section className="journal-block">
      <h4>{title}</h4>
      <ul className="journal-buckets">
        {buckets.map((bucket) => (
          <li key={bucket.key}>
            <span className="journal-bucket-label">{bucket.label}</span>
            <span className="journal-bucket-bar">
              <span
                className={`journal-bucket-fill ${bucket.netPnlMicros >= 0 ? 'up' : 'down'}`}
                style={{ width: `${(Math.abs(bucket.netPnlMicros) / peak) * 100}%` }}
              />
            </span>
            <span className="num journal-bucket-trades">{bucket.trades}</span>
            <span className={`num journal-bucket-pnl ${bucket.netPnlMicros >= 0 ? 'up' : 'down'}`}>
              {masked ? MASK : formatMicros(bucket.netPnlMicros, { sign: true })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Realized equity after each closed trade, drawn as an SVG path. */
function EquityCurve({
  analytics,
  masked,
}: {
  analytics: ApiAnalytics;
  masked: boolean;
}): JSX.Element {
  const points = analytics.curve.points;
  const path = useMemo(() => {
    if (points.length === 0) return '';
    const values = [analytics.curve.startMicros, ...points.map((p) => p.equityMicros)];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = 100 / Math.max(1, values.length - 1);
    return values
      .map((value, index) => {
        const x = index * stepX;
        const y = 100 - ((value - min) / span) * 100;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [analytics.curve.startMicros, points]);

  const up = analytics.curve.endMicros >= analytics.curve.startMicros;

  return (
    <section className="journal-block">
      <h4>
        Equity curve
        <span className={`num journal-curve-end ${up ? 'up' : 'down'}`}>
          {masked
            ? MASK
            : formatMicros(analytics.curve.endMicros - analytics.curve.startMicros, { sign: true })}
        </span>
      </h4>
      {points.length === 0 ? (
        <div className="journal-empty">Nothing closed yet.</div>
      ) : (
        <svg className="journal-curve" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d={path} className={up ? 'up' : 'down'} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </section>
  );
}

// --------------------------------------------------------------- calendar ---

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

interface DayResult {
  readonly tradeDate: string;
  readonly netPnlMicros: number;
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
}

/** A trading date - 2026-09-17 - as a calendar day, with no timezone in it. */
function parseDate(tradeDate: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradeDate);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function monthName(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The trading month.
 *
 * A real calendar: seven columns from Sunday, the weeks of the month as rows,
 * every day of the month in its own square whether or not it was traded, and a
 * total for each week beside it. The previous version was a strip of cards for
 * the days that happened to have trades, which tells a trader nothing about
 * WHEN in the month they were losing money.
 */
function Calendar({
  analytics,
  masked,
  onPickDay,
}: {
  analytics: ApiAnalytics | null;
  masked: boolean;
  onPickDay: (tradeDate: string) => void;
}): JSX.Element {
  const days: readonly DayResult[] = analytics?.days ?? [];
  const byDate = useMemo(() => new Map(days.map((day) => [day.tradeDate, day])), [days]);

  // Which months have anything in them, newest first, so the arrows can only
  // walk to a month the account actually traded in - plus the current one.
  const months = useMemo(() => {
    const seen = new Set<string>();
    for (const day of days) {
      const parsed = parseDate(day.tradeDate);
      if (parsed) seen.add(monthKey(parsed.year, parsed.month));
    }
    const now = new Date();
    seen.add(monthKey(now.getUTCFullYear(), now.getUTCMonth()));
    return [...seen].sort();
  }, [days]);

  const [cursor, setCursor] = useState<string>(() => months[months.length - 1] ?? '');
  const index = Math.max(0, months.indexOf(cursor));
  const shown = months[index] ?? months[months.length - 1] ?? '';
  const [yearText, monthText] = shown.split('-');
  const year = Number(yearText);
  const month = Number(monthText) - 1;

  if (!shown || Number.isNaN(year)) {
    return <div className="journal-empty">No trading days recorded yet.</div>;
  }

  // The grid: leading blanks to the first weekday, then every day of the month.
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: Array<DayResult | { blank: true } | { day: number }> = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push({ blank: true });
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${shown}-${String(day).padStart(2, '0')}`;
    cells.push(byDate.get(key) ?? { day });
  }
  while (cells.length % 7 !== 0) cells.push({ blank: true });

  const weeks: Array<Array<(typeof cells)[number]>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const traded = days.filter((day) => day.tradeDate.startsWith(shown));
  const monthNet = traded.reduce((sum, day) => sum + day.netPnlMicros, 0);
  const monthTrades = traded.reduce((sum, day) => sum + day.trades, 0);
  const green = traded.filter((day) => day.netPnlMicros > 0).length;

  const money = (micros: number): string =>
    masked ? MASK : formatMicros(micros, { sign: true });

  return (
    <div className="journal-body">
      <section className="journal-block">
        <header className="cal-head">
          <button
            className="cal-nav"
            onClick={() => setCursor(months[Math.max(0, index - 1)] ?? shown)}
            disabled={index <= 0}
            aria-label="Previous month"
          >
            ‹
          </button>
          <h4 data-testid="calendar-month">{monthName(year, month)}</h4>
          <button
            className="cal-nav"
            onClick={() => setCursor(months[Math.min(months.length - 1, index + 1)] ?? shown)}
            disabled={index >= months.length - 1}
            aria-label="Next month"
          >
            ›
          </button>
          <div className="hdr-spacer" />
          <span className="cal-total" data-testid="calendar-total">
            <b className={monthNet >= 0 ? 'up' : 'down'}>{money(monthNet)}</b>
            <span className="cal-total-sub">
              {traded.length} day{traded.length === 1 ? '' : 's'} · {monthTrades} trade
              {monthTrades === 1 ? '' : 's'} · {green} green
            </span>
          </span>
        </header>

        <div className="cal-grid" data-testid="calendar-grid">
          {WEEKDAYS.map((label) => (
            <div className="cal-weekday" key={label}>
              {label}
            </div>
          ))}
          <div className="cal-weekday cal-weekday-total">Week</div>

          {weeks.map((week, weekIndex) => {
            const weekDays = week.filter((cell): cell is DayResult => 'tradeDate' in cell);
            const weekNet = weekDays.reduce((sum, day) => sum + day.netPnlMicros, 0);
            return (
              <Fragment key={weekIndex}>
                {week.map((cell, cellIndex) => {
                  if ('blank' in cell) {
                    return <div className="cal-cell cal-cell-blank" key={cellIndex} />;
                  }
                  if (!('tradeDate' in cell)) {
                    return (
                      <div className="cal-cell cal-cell-quiet" key={cellIndex}>
                        <span className="cal-day">{cell.day}</span>
                      </div>
                    );
                  }
                  const parsed = parseDate(cell.tradeDate);
                  const positive = cell.netPnlMicros >= 0;
                  return (
                    <button
                      className={`cal-cell cal-cell-traded ${positive ? 'up' : 'down'}`}
                      key={cellIndex}
                      data-testid="calendar-day"
                      data-date={cell.tradeDate}
                      onClick={() => onPickDay(cell.tradeDate)}
                      title={`${cell.tradeDate}: ${cell.trades} trades, ${cell.wins}W ${cell.losses}L`}
                    >
                      <span className="cal-day">{parsed?.day ?? ''}</span>
                      <span className="num cal-pnl">{money(cell.netPnlMicros)}</span>
                      <span className="cal-count">
                        {cell.trades} trade{cell.trades === 1 ? '' : 's'}
                      </span>
                    </button>
                  );
                })}
                <div
                  className={`cal-cell cal-week ${weekDays.length === 0 ? 'cal-cell-quiet' : weekNet >= 0 ? 'up' : 'down'}`}
                  data-testid="calendar-week"
                >
                  {weekDays.length > 0 ? (
                    <>
                      <span className="num cal-pnl">{money(weekNet)}</span>
                      <span className="cal-count">
                        {weekDays.length} day{weekDays.length === 1 ? '' : 's'}
                      </span>
                    </>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ----------------------------------------------------------------- trades ---

function Trades({
  trades,
  tags,
  masked,
  onChanged,
  onTagsChanged,
  day = null,
  onClearDay,
}: {
  trades: ApiJournalTrade[];
  tags: ApiTag[];
  masked: boolean;
  onChanged: () => Promise<void>;
  onTagsChanged: (tags: ApiTag[]) => void;
  /** The calendar day being shown, when the list was opened from one. */
  day?: string | null;
  onClearDay?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newTag, setNewTag] = useState('');
  const setChartFocus = useSession((s) => s.focusTrade);
  const instruments = useSession((s) => s.instruments);

  /*
   * A price is printed at its instrument's precision, not at whatever
   * JavaScript makes of the number: an NQ exit at 29455.50 printed itself as
   * "29455.5" beside an entry of "29460.75", and a column of prices that do
   * not line up is read as a different price rather than as a lost zero.
   */
  const price = useCallback(
    (value: number, root: string): string => {
      const digits = instruments.find((i) => i.root === root)?.pricePrecision ?? 2;
      return value.toFixed(digits);
    },
    [instruments],
  );

  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);

  const dayChip = day ? (
    <div className="journal-daychip" data-testid="journal-day-filter">
      <span>
        Showing <b>{day}</b> · {trades.length} trade{trades.length === 1 ? '' : 's'}
      </span>
      <button className="chip" onClick={onClearDay} aria-label="Show every trade">
        Show all
      </button>
    </div>
  ) : null;

  if (trades.length === 0) {
    return (
      <div className="journal-body">
        {dayChip}
        <div className="journal-empty">
          {day ? 'No trades on that day.' : 'No trades recorded yet.'}
        </div>
      </div>
    );
  }

  const toggleTag = async (trade: ApiJournalTrade, tagId: string): Promise<void> => {
    const next = trade.tagIds.includes(tagId)
      ? trade.tagIds.filter((id) => id !== tagId)
      : [...trade.tagIds, tagId];
    await journalApi.setTradeTags(trade.id, next);
    await onChanged();
  };

  return (
    <div className="journal-body">
      {dayChip}
      <ul className="journal-trades">
        {trades.map((trade) => {
          const expanded = open === trade.id;
          return (
            <li key={trade.id} className={expanded ? 'expanded' : ''}>
              <button
                className="journal-trade-head"
                onClick={() => {
                  setOpen(expanded ? null : trade.id);
                  setDraft(trade.notes ?? '');
                }}
              >
                <span className={`journal-trade-side ${trade.side === 'LONG' ? 'up' : 'down'}`}>
                  {trade.side}
                </span>
                <span className="journal-trade-symbol">{trade.symbol}</span>
                <span className="num">{trade.qty}</span>
                <span className="num journal-trade-price">
                  {price(trade.entryPrice, trade.symbol)} → {price(trade.exitPrice, trade.symbol)}
                </span>
                <span className={`num journal-trade-pnl ${trade.netPnlMicros >= 0 ? 'up' : 'down'}`}>
                  {masked ? MASK : formatMicros(trade.netPnlMicros, { sign: true })}
                </span>
                <span className="num journal-trade-r">
                  {trade.rMultiple === null ? '—' : `${trade.rMultiple.toFixed(2)}R`}
                </span>
                <span className="journal-trade-tags">
                  {trade.tagIds.map((id) => {
                    const tag = tagById.get(id);
                    return tag ? (
                      <span key={id} className={`journal-tag journal-tag-${tag.kind.toLowerCase()}`}>
                        {tag.name}
                      </span>
                    ) : null;
                  })}
                </span>
              </button>

              {expanded ? (
                <div className="journal-trade-body">
                  <div className="journal-trade-facts">
                    <span>
                      held <b>{duration(trade.holdMs)}</b>
                    </span>
                    <span>
                      MAE <b className="down">{masked ? MASK : formatMicros(trade.maeMicros)}</b>
                    </span>
                    <span>
                      MFE <b className="up">{masked ? MASK : formatMicros(trade.mfeMicros)}</b>
                    </span>
                    <span>
                      risk{' '}
                      <b>
                        {trade.initialRiskMicros === null
                          ? 'none'
                          : masked
                            ? MASK
                            : formatMicros(trade.initialRiskMicros)}
                      </b>
                    </span>
                    <span>
                      fees <b>{masked ? MASK : formatMicros(trade.feesMicros)}</b>
                    </span>
                    <button
                      className="chip journal-chart-btn"
                      onClick={() =>
                        setChartFocus({
                          symbol: trade.symbol,
                          entryTime: trade.entryTime,
                          exitTime: trade.exitTime,
                          entryPrice: trade.entryPrice,
                          exitPrice: trade.exitPrice,
                          side: trade.side,
                        })
                      }
                      title="Show this trade on the chart"
                    >
                      Show on chart
                    </button>
                  </div>

                  <div className="journal-tag-picker">
                    {tags.map((tag) => (
                      <button
                        key={tag.id}
                        className={`journal-tag journal-tag-${tag.kind.toLowerCase()} ${
                          trade.tagIds.includes(tag.id) ? 'on' : ''
                        }`}
                        onClick={() => void toggleTag(trade, tag.id)}
                      >
                        {tag.name}
                      </button>
                    ))}
                    <input
                      className="journal-new-tag"
                      placeholder="new tag…"
                      value={newTag}
                      onChange={(e) => setNewTag(e.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' || newTag.trim() === '') return;
                        void journalApi
                          .createTag({ name: newTag.trim() })
                          .then(async (created) => {
                            setNewTag('');
                            const next = await journalApi.tags();
                            onTagsChanged(next.tags);
                            await journalApi.setTradeTags(trade.id, [...trade.tagIds, created.tag.id]);
                            await onChanged();
                          })
                          .catch(() => undefined);
                      }}
                    />
                  </div>

                  <textarea
                    className="journal-notes"
                    placeholder="What happened here?"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                      if (draft === (trade.notes ?? '')) return;
                      void journalApi
                        .setNotes(trade.id, draft.trim() === '' ? null : draft)
                        .then(() => onChanged())
                        .catch(() => undefined);
                    }}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --------------------------------------------------------------- sessions ---

function Sessions({
  sessions,
  selected,
  review,
  onOpen,
  masked,
}: {
  sessions: ApiPracticeSession[];
  selected: string | null;
  review: ApiSessionReview | null;
  onOpen: (id: string) => Promise<void>;
  masked: boolean;
}): JSX.Element {
  if (sessions.length === 0) {
    return <div className="journal-empty">No practice sessions yet. Start one in Practice.</div>;
  }

  return (
    <div className="journal-body">
      <ul className="journal-sessions">
        {sessions.map((session) => (
          <li key={session.id} className={selected === session.id ? 'selected' : ''}>
            <button className="journal-session-head" onClick={() => void onOpen(session.id)}>
              <span className="journal-session-mode">{session.mode.replace('_', ' ')}</span>
              <span className="journal-session-date">
                {session.tradingDate ?? (session.dateHidden ? 'hidden' : '—')}
              </span>
              <span className="journal-session-symbol">{session.symbol ?? '—'}</span>
              <span
                className={`num journal-session-pnl ${
                  (session.endingBalanceMicros ?? session.startingBalanceMicros) >=
                  session.startingBalanceMicros
                    ? 'up'
                    : 'down'
                }`}
              >
                {session.endedAt === null
                  ? 'running'
                  : masked
                    ? MASK
                    : formatMicros(
                        (session.endingBalanceMicros ?? session.startingBalanceMicros) -
                          session.startingBalanceMicros,
                        { sign: true },
                      )}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {review && selected ? <Review review={review} masked={masked} /> : null}
    </div>
  );
}

function Review({ review, masked }: { review: ApiSessionReview; masked: boolean }): JSX.Element {
  const s = review.stats;
  const money = (micros: number | null, signed = false): string =>
    masked ? MASK : micros === null ? '—' : formatMicros(micros, { sign: signed });

  return (
    <section className="journal-block journal-review">
      <h4>
        Session review
        <span className="journal-review-meta">
          {review.tradingDate ?? 'date withheld'} · {review.symbol ?? '—'} ·{' '}
          {review.mode.replace('_', ' ').toLowerCase()}
        </span>
      </h4>

      <div className="journal-stats">
        <Stat
          label="Net P&L"
          value={money(review.netPnlMicros, true)}
          tone={review.netPnlMicros >= 0 ? 'up' : 'down'}
        />
        <Stat label="Trades" value={String(s.trades)} />
        <Stat label="Win rate" value={pct(s.winRate)} />
        <Stat label="Expectancy" value={money(s.expectancyMicros, true)} />
        <Stat label="Profit factor" value={ratio(s.profitFactor)} />
        <Stat label="Max drawdown" value={money(review.curve.maxDrawdownMicros)} tone="down" />
        <Stat label="Best trade" value={money(review.bestTrade?.netPnlMicros ?? null, true)} tone="up" />
        <Stat
          label="Worst trade"
          value={money(review.worstTrade?.netPnlMicros ?? null, true)}
          tone="down"
        />
      </div>

      {review.programme ? (
        <div className="journal-programme">
          <span className={`journal-programme-status journal-${review.programme.status.toLowerCase()}`}>
            {review.programme.status.replace('_', ' ')}
          </span>
          {review.programme.requirements.map((req) => (
            <span key={req.key} className={`journal-req ${req.met ? 'met' : ''}`}>
              {req.met ? '✓' : '○'} {req.label}
            </span>
          ))}
        </div>
      ) : null}

      {review.violations.length > 0 ? (
        <div className="journal-violations">
          <h5>Rule violations</h5>
          <ul>
            {review.violations.map((violation, index) => (
              <li key={`${violation.rule}-${index}`}>
                <b>{violation.rule.replace(/_/g, ' ').toLowerCase()}</b>{' '}
                <span className="journal-violation-time">
                  {new Date(violation.at).toLocaleTimeString('en-US', { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="journal-note">No rule violations in this session.</p>
      )}
    </section>
  );
}
