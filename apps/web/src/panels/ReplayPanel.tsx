import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useSession } from '../state/session';
import {
  captureSession,
  fetchRecordings,
  replayApi,
  type RecordingSummary,
  type ReplayState,
} from '../market/api';
import './ReplayPanel.css';

const SPEEDS = [1, 2, 5, 10, 25, 50] as const;

/**
 * Recorded-session replay.
 *
 * Replay exists so the execution engine can be exercised outside market hours.
 * The data is always a real recorded session: the controls change how fast the
 * clock runs, never what the prices are.
 */
export function ReplayPanel(): JSX.Element {
  const activeSymbol = useSession((s) => s.activeSymbol);
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [state, setState] = useState<ReplayState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captureDate, setCaptureDate] = useState(() => defaultCaptureDate());
  const [providerMode, setProviderMode] = useState<'live' | 'replay'>('live');

  const refresh = useCallback(async () => {
    try {
      const [list, replayState] = await Promise.all([fetchRecordings(), replayApi.state()]);
      setRecordings(list.recordings);
      setState(replayState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read replay state.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Replay command failed.');
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const onCapture = () =>
    run(async () => {
      await captureSession(activeSymbol, captureDate, '1m');
    });

  const onUseProvider = (mode: 'live' | 'replay') =>
    run(async () => {
      await replayApi.useProvider(mode);
      setProviderMode(mode);
    });

  return (
    <div className="replay-panel">
      <div className="replay-section">
        <div className="label">Data source</div>
        <div className="replay-row">
          <button
            className={`chip ${providerMode === 'live' ? 'chip-on' : ''}`}
            disabled={busy}
            onClick={() => void onUseProvider('live')}
          >
            Live delayed feed
          </button>
          <button
            className={`chip ${providerMode === 'replay' ? 'chip-on' : ''}`}
            disabled={busy || !state?.loaded}
            onClick={() => void onUseProvider('replay')}
            title={state?.loaded ? 'Route the platform through the replay' : 'Load a recording first'}
          >
            Replay
          </button>
        </div>
        <p className="replay-note">
          Switching source clears the candle aggregators. A chart never mixes live and
          replayed data in one series.
        </p>
      </div>

      <div className="replay-section">
        <div className="label">Capture a real session</div>
        <div className="replay-row">
          <input
            type="date"
            value={captureDate}
            onChange={(e) => setCaptureDate(e.target.value)}
            className="num"
          />
          <button className="chip" disabled={busy} onClick={() => void onCapture()}>
            Capture {activeSymbol}
          </button>
        </div>
        <p className="replay-note">
          Writes one exchange session of real 1-minute bars to a replay file. The development
          feed serves only 7 days of 1-minute history.
        </p>
      </div>

      <div className="replay-section">
        <div className="label">Recordings ({recordings.length})</div>
        <div className="replay-list">
          {recordings.length === 0 ? (
            <div className="replay-empty">No recordings captured yet.</div>
          ) : (
            recordings.map((r) => (
              <button
                key={r.id}
                className={`replay-item ${state?.recordingId === r.id ? 'replay-item-active' : ''}`}
                disabled={busy}
                onClick={() => void run(() => replayApi.load(r.id))}
              >
                <span className="replay-item-symbol">{r.header.symbol}</span>
                <span className="num">{r.header.tradingDate}</span>
                <span className="num replay-item-count">
                  {r.header.eventCount.toLocaleString('en-US')} bars
                </span>
                <span className="replay-item-method">{r.header.captureMethod}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {state?.loaded ? (
        <div className="replay-section">
          <div className="label">Transport</div>
          <div className="replay-row">
            <button
              className="chip chip-on"
              disabled={busy}
              onClick={() => void run(() => (state.playing ? replayApi.pause() : replayApi.play()))}
            >
              {state.playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button className="chip" disabled={busy} onClick={() => void run(() => replayApi.reset())}>
              ⏮ Reset
            </button>
          </div>

          <div className="replay-row replay-speeds">
            {SPEEDS.map((speed) => (
              <button
                key={speed}
                className={`chip ${state.speed === speed ? 'chip-on' : ''}`}
                disabled={busy}
                onClick={() => void run(() => replayApi.speed(speed))}
              >
                {speed}×
              </button>
            ))}
          </div>

          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(state.progress * 1000)}
            className="replay-scrub"
            onChange={(e) => void run(() => replayApi.seek(Number(e.target.value) / 1000))}
          />

          <div className="replay-status num">
            {state.cursor.toLocaleString('en-US')} / {state.total.toLocaleString('en-US')} events
            {state.clock ? ` · ${new Date(state.clock).toISOString().slice(11, 16)}Z` : ''}
          </div>
        </div>
      ) : null}

      {error ? <div className="replay-error">{error}</div> : null}
    </div>
  );
}

/** Yesterday, which is always inside the feed's 7-day 1-minute window. */
function defaultCaptureDate(): string {
  const d = new Date(Date.now() - 86_400_000);
  return d.toISOString().slice(0, 10);
}
