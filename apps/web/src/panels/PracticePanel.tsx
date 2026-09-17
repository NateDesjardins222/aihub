/**
 * Practice: training modes, historical sessions and the replay transport.
 *
 * A practice session is three separate decisions - which market to replay, what
 * the trader may see while they do it, and what the account's rules are - and
 * this panel is where all three are made. None of them touches how the engine
 * fills: a mode that hides the money hides it on screen and nowhere else.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSession, selectedAccount } from '../state/session';
import { useTrading } from '../trading/store';
import { useTraining, TRAINING_MODES, type TrainingModeId } from '../state/training';
import { journalApi, type ApiPracticeSession } from '../trading/journal-api';
import { tradingApi } from '../trading/api';
import { captureSession as captureRecording, replayApi, type ReplayState } from '../market/api';
import { formatMicros } from '../state/format';
import { refreshReplayStatus, useReplayStatus } from '../state/replay-status';
import './PracticePanel.css';

const SPEEDS = [0.5, 1, 2, 5, 10, 25, 50, 100] as const;
const BALANCES = [25_000, 50_000, 100_000, 150_000, 250_000] as const;
const DOLLARS = 1_000_000;

interface Anchor {
  id: string;
  label: string;
  description: string;
  at: number | null;
  offsetMs: number;
}

export function PracticePanel(): JSX.Element {
  const account = useSession(selectedAccount);
  const accountId = useTrading((s) => s.accountId);
  const refresh = useTrading((s) => s.refresh);
  const loadRules = useTrading((s) => s.loadRules);
  const modeId = useTraining((s) => s.modeId);
  const setMode = useTraining((s) => s.setMode);
  const visibility = useTraining((s) => s.visibility);
  const setVisibility = useTraining((s) => s.setVisibility);
  const reveal = useTraining((s) => s.reveal);

  const [state, setState] = useState<ReplayState | null>(null);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [sessions, setSessions] = useState<
    Array<{ id: string; tradingDate: string; events: number; captureMethod: string }>
  >([]);
  const [dates, setDates] = useState<Array<{ date: string; captured: boolean }>>([]);
  const [symbol, setSymbol] = useState('NQ');
  const [balance, setBalance] = useState(100_000);
  const [active, setActive] = useState<ApiPracticeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    try {
      const [replayState, anchorList] = await Promise.all([
        replayApi.state(),
        replayApi.anchors().catch(() => ({ anchors: [] })),
      ]);
      setState(replayState);
      setAnchors(anchorList.anchors);
      // The shared badge is derived from the market's MODE, not from whether a
      // recording happens to be loaded, so it is refreshed rather than written
      // here. Refreshed immediately, so pressing Play clears "REPLAY PAUSED"
      // at once instead of on the next poll.
      void refreshReplayStatus();
    } catch {
      /* the panel shows its own error on the next action */
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const available = await replayApi.availableSessions(symbol, 12);
      setSessions(
        available.recordings.map((r) => ({
          id: r.id,
          tradingDate: r.tradingDate,
          events: r.events,
          captureMethod: r.captureMethod,
        })),
      );
      setDates(available.dates);
    } catch {
      /* leave the list as it was */
    }
  }, [symbol]);

  useEffect(() => {
    void refreshState();
    const id = window.setInterval(() => void refreshState(), 2_000);
    return () => window.clearInterval(id);
  }, [refreshState]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!accountId) return;
    void journalApi
      .activeSession(accountId)
      .then((result) => setActive(result.session))
      .catch(() => undefined);
  }, [accountId]);

  const run = useCallback(
    async (action: () => Promise<unknown>, message?: string) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        await action();
        if (message) setNote(message);
        await refreshState();
      } catch (err) {
        const detail = err as { code?: string; message?: string };
        setError(detail.message ?? 'That did not work.');
      } finally {
        setBusy(false);
      }
    },
    [refreshState],
  );

  // --- starting a session -------------------------------------------------

  const startSession = useCallback(
    async (options: { recordingId?: string; random?: boolean; date?: string }) => {
      if (!accountId) return;
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const mode = TRAINING_MODES.find((m) => m.id === modeId)!;

        // A session starts from a known balance, so two attempts at the same
        // day are comparable. This is a reset, and it clears the account.
        await tradingApi.resetAccount(accountId, balance * DOLLARS);

        let replayState: ReplayState;
        if (options.random || mode.randomSession) {
          replayState = await replayApi.random(symbol, true);
        } else {
          let recordingId = options.recordingId;
          if (!recordingId && options.date) {
            // Capture the day on demand: real bars from the feed, never
            // anything generated to fill a date that has no data.
            recordingId = await captureSession(symbol, options.date);
            await refreshSessions();
          }
          if (!recordingId) throw new Error('Choose a session first.');
          replayState = await replayApi.load(recordingId);
        }

        await replayApi.useProvider('replay');
        await replayApi.speed(1);

        const session = await journalApi.startSession({
          accountId,
          source: 'REPLAY',
          mode: modeId,
          config: { visibility, symbol, startingBalance: balance },
          recordingId: replayState.recordingId,
          symbol: replayState.symbol ?? symbol,
          tradingDate: replayState.header?.tradingDate ?? null,
          dateHidden: !visibility.dateTime,
        });
        setActive(session.session);
        await Promise.all([refresh(), loadRules(), refreshState()]);
        setNote('Session started. Press play when you are ready.');
      } catch (err) {
        const detail = err as { message?: string };
        setError(detail.message ?? 'Could not start the session.');
      } finally {
        setBusy(false);
      }
    },
    [accountId, balance, loadRules, modeId, refresh, refreshSessions, refreshState, symbol, visibility],
  );

  /** Leave the replay provider, whether or not a session is running. */
  const backToLive = useCallback(async () => {
    setBusy(true);
    try {
      await replayApi.pause().catch(() => undefined);
      await replayApi.useProvider('live');
      reveal();
      setNote('Back on the live market.');
      await Promise.all([refresh(), refreshState()]);
      await refreshReplayStatus();
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not return to the live market.');
    } finally {
      setBusy(false);
    }
  }, [refresh, refreshState, reveal]);

  const endSession = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    try {
      await replayApi.pause().catch(() => undefined);
      await journalApi.endSession(active.id);
      // Back to the live feed. Leaving the server on the replay provider means
      // the terminal keeps showing a finished session's prices, and the next
      // history load reports that the replay has emitted no bars - which is
      // true, and useless.
      await replayApi.useProvider('live').catch(() => undefined);
      // The mode's promise: whatever it hid while trading comes back now.
      reveal();
      setActive(null);
      setNote('Session ended. The review is in the Journal.');
      await Promise.all([refresh(), refreshState()]);
    } catch (err) {
      setError((err as { message?: string }).message ?? 'Could not end the session.');
    } finally {
      setBusy(false);
    }
  }, [active, refresh, refreshState, reveal]);

  const routedToReplay = useReplayStatus((s) => s.isReplay);
  const loaded = state?.loaded ?? false;
  const playing = state?.playing ?? false;
  const blind = state?.blind ?? false;

  return (
    <div className="practice-panel">
      {/* --- training mode ------------------------------------------------ */}
      <section className="practice-section">
        <div className="label">Training mode</div>
        <div className="practice-modes">
          {TRAINING_MODES.map((mode) => (
            <button
              key={mode.id}
              className={`chip ${modeId === mode.id ? 'chip-on' : ''}`}
              onClick={() => setMode(mode.id as TrainingModeId)}
              title={mode.description}
            >
              {mode.name}
            </button>
          ))}
        </div>
        <p className="practice-note">
          {TRAINING_MODES.find((m) => m.id === modeId)?.description}
        </p>
        <p className="practice-note practice-emphasis">
          A mode changes what you SEE. Fills, rules, P&amp;L and the journal are unaffected, and
          everything hidden is still recorded.
        </p>

        <div className="practice-visibility">
          {(
            [
              ['pnl', 'P&L'],
              ['balance', 'Balance'],
              ['tradeResults', 'Trade results'],
              ['dateTime', 'Date & clock'],
              ['rules', 'Rule progress'],
              ['journal', 'Journal'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="practice-toggle">
              <input
                type="checkbox"
                checked={visibility[key]}
                onChange={(e) => setVisibility({ [key]: e.target.checked })}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* --- the session -------------------------------------------------- */}
      <section className="practice-section">
        <div className="label">Session</div>
        <div className="practice-row">
          <select
            className="practice-select"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            disabled={busy || Boolean(active)}
          >
            {['NQ', 'ES', 'CL', 'GC', 'MNQ', 'MES'].map((root) => (
              <option key={root} value={root}>
                {root}
              </option>
            ))}
          </select>
          <select
            className="practice-select"
            value={balance}
            onChange={(e) => setBalance(Number(e.target.value))}
            disabled={busy || Boolean(active)}
            title="The account is reset to this balance when the session starts"
          >
            {BALANCES.map((size) => (
              <option key={size} value={size}>
                ${(size / 1000).toFixed(0)}K
              </option>
            ))}
          </select>
          <button
            className="chip"
            disabled={busy || Boolean(active)}
            onClick={() => void startSession({ random: true })}
            title="An unknown session, chosen at random, with its date withheld"
          >
            Random session
          </button>
        </div>

        {active ? (
          <div className="practice-active">
            <div className="practice-active-row">
              <span className="practice-active-dot" />
              <b>Session running</b>
              <span className="practice-active-meta">
                {active.dateHidden ? 'unknown date' : (active.tradingDate ?? '—')} ·{' '}
                {active.symbol ?? symbol} · {formatMicros(active.startingBalanceMicros)} start
              </span>
            </div>
            <button className="chip" disabled={busy} onClick={() => void endSession()}>
              End session &amp; review
            </button>
          </div>
        ) : routedToReplay ? (
          /*
           * Routed through a replay with no session running.
           *
           * A reload in the middle of one leaves the terminal exactly here, and
           * without a way out it shows a finished session's prices for ever.
           */
          <div className="practice-active">
            <div className="practice-active-row">
              <span className="practice-active-dot" />
              <b>Replaying</b>
              <span className="practice-active-meta">no session is being recorded</span>
            </div>
            <button
              className="chip"
              disabled={busy}
              data-testid="back-to-live"
              onClick={() => void backToLive()}
            >
              Return to the live market
            </button>
          </div>
        ) : (
          <>
            <div className="practice-sessions">
              {sessions.length === 0 ? (
                <div className="practice-empty">No {symbol} days ready yet. Pick one below.</div>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.id}
                    className="practice-session"
                    disabled={busy}
                    onClick={() => void startSession({ recordingId: session.id })}
                  >
                    {/*
                      A day, described the way a trader would describe it. The
                      event count and the capture method were dataset
                      bookkeeping: they belong to whoever is debugging the feed,
                      not to whoever is about to trade the day.
                    */}
                    <span className="practice-session-date">{sessionDayLabel(session.tradingDate)}</span>
                    <span className="practice-session-method">{session.tradingDate}</span>
                  </button>
                ))
              )}
            </div>

            <div className="label practice-sub">Another day</div>
            <div className="practice-dates">
              {dates.map((date) => (
                <button
                  key={date.date}
                  className={`chip ${date.captured ? 'chip-on' : ''}`}
                  disabled={busy}
                  title={
                    date.captured
                      ? 'Ready to trade - start it above'
                      : 'Prepare this day for practice'
                  }
                  onClick={() =>
                    void run(async () => {
                      await captureSession(symbol, date.date);
                      await refreshSessions();
                    }, `Captured ${symbol} ${date.date}.`)
                  }
                >
                  {date.date.slice(5)}
                </button>
              ))}
            </div>
            <p className="practice-note">
              One-minute history reaches back about a week on the development feed. A date with no
              data is reported as such rather than filled in.
            </p>
          </>
        )}
      </section>

      {/* --- playback ------------------------------------------------------ */}
      {loaded ? (
        <section className="practice-section">
          <div className="label">Playback</div>
          <div className="practice-row">
            <button
              className="chip chip-on"
              disabled={busy}
              onClick={() =>
                void run(() => (playing ? replayApi.pause() : replayApi.play()))
              }
            >
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button
              className="chip"
              disabled={busy}
              onClick={() => void run(() => replayApi.step(1))}
              title="Move forward one market update"
            >
              ⏭ Step
            </button>
            <button
              className="chip"
              disabled={busy}
              onClick={() => void run(() => replayApi.step(30))}
              title="Move forward thirty market updates"
            >
              +30
            </button>
            <button
              className="chip"
              disabled={busy}
              onClick={() => void run(() => replayApi.restart())}
              title="Start this day again from the beginning"
            >
              ⏮ Restart
            </button>
          </div>

          <div className="practice-row practice-speeds">
            {SPEEDS.map((speed) => (
              <button
                key={speed}
                className={`chip ${state?.speed === speed ? 'chip-on' : ''}`}
                disabled={busy}
                onClick={() => void run(() => replayApi.speed(speed))}
              >
                {speed}×
              </button>
            ))}
          </div>

          <div className="practice-row">
            {[5, 15, 60].map((minutes) => (
              <button
                key={minutes}
                className="chip"
                disabled={busy || !accountId}
                title="Only while flat with nothing working"
                onClick={() =>
                  void run(
                    () => replayApi.skip(accountId!, minutes),
                    `Skipped ${minutes} minutes.`,
                  )
                }
              >
                Skip {minutes}m
              </button>
            ))}
          </div>

          {anchors.length > 0 ? (
            <>
              <div className="label practice-sub">Jump to</div>
              <div className="practice-row practice-anchors">
                {anchors.map((anchor) => (
                  <button
                    key={anchor.id}
                    className="chip"
                    disabled={busy || anchor.at === null}
                    title={
                      anchor.at === null
                        ? 'Hidden while the session is blind: jumping to it would reveal the date'
                        : anchor.description
                    }
                    onClick={() => void run(() => replayApi.seekTime(anchor.at!), `Jumped to ${anchor.label}.`)}
                  >
                    {anchor.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round((state?.progress ?? 0) * 1000)}
            className="practice-scrub"
            disabled={busy}
            onChange={(e) => void run(() => replayApi.seek(Number(e.target.value) / 1000))}
          />
          {/*
            Where the day has got to, in the terms a trader thinks in: the
            market's clock and how much of the session is left. The raw event
            cursor was a progress bar for a dataset.
          */}
          <div className="practice-status num">
            {blind
              ? `${formatElapsed(state?.elapsedMs ?? null)} in`
              : state?.clock
                ? `${new Date(state.clock).toISOString().slice(11, 16)}Z`
                : '—'}
            {` · ${Math.round((state?.progress ?? 0) * 100)}% through the day`}
          </div>
          {loaded && !playing ? (
            <p className="practice-note practice-emphasis">
              Paused. Orders can be placed, and they wait: an order becomes eligible to fill once
              the market has moved on by its latency, and a paused market has not moved at all.
            </p>
          ) : null}
          <p className="practice-note">
            In a replay, simulated latency is measured on the MARKET&apos;s clock rather than the
            wall clock. That is what makes a session repeatable at any speed - and it means an
            order placed between two prints fills on the next one, not on the last one. Set latency
            to zero in Sim settings for immediate fills.
          </p>
          {blind ? (
            <p className="practice-note">
              This session is blind: its date, its clock and its identity stay hidden until you end
              it. The data is a real recorded session.
            </p>
          ) : null}
        </section>
      ) : null}

      {error ? <div className="practice-error">{error}</div> : null}
      {note ? <div className="practice-ok">{note}</div> : null}
      {!account ? <div className="practice-empty">Select an account first.</div> : null}
    </div>
  );
}

/**
 * Capture one historical session.
 *
 * Real bars, fetched from the feed for that date. A date the vendor cannot
 * serve fails loudly rather than producing a session made of nothing.
 */
async function captureSession(symbol: string, date: string): Promise<string> {
  const summary = await captureRecording(symbol, date, '1m');
  return summary.id;
}

/**
 * A trading date as a person would say it: "Tue 15 Sep".
 *
 * The panel used to list a date and an event count, which is how a dataset is
 * described rather than how a day is.
 */
function sessionDayLabel(tradingDate: string): string {
  const parsed = new Date(`${tradingDate}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return tradingDate;
  return parsed.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatElapsed(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}
