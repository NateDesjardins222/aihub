import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { ConnectionStatus } from '@atlas/contracts';
import { marketStream, type StreamDiagnostics } from '../market/stream';
import type { FreshnessInfo } from '../market/api';

/**
 * Feed status badge.
 *
 * This component exists to make one thing impossible: presenting delayed data as
 * real-time. It always shows the feed's declared mode and, for a delayed feed,
 * the measured delay. When data goes stale or the market is closed it says so
 * explicitly, because that is when a trader is most likely to be misled.
 */
export function FeedBadge({ freshness }: { freshness: FreshnessInfo | null }): JSX.Element {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<StreamDiagnostics | null>(null);

  useEffect(() => {
    const offStatus = marketStream.subscribeStatus(setStatus);
    const offDiag = marketStream.subscribeDiagnostics(setDiagnostics);
    return () => {
      offStatus();
      offDiag();
    };
  }, []);

  const socketDown = diagnostics !== null && !diagnostics.connected;
  const mode = status?.mode ?? null;
  const delaySeconds = status?.delaySeconds ?? null;

  let tone = 'conn-delayed';
  let label = 'CONNECTING';
  let detail = 'Establishing the market data stream.';

  if (socketDown) {
    tone = 'conn-down';
    label = diagnostics!.reconnectAttempts > 0 ? 'RECONNECTING' : 'DISCONNECTED';
    detail = `WebSocket is down. Reconnect attempt ${diagnostics!.reconnectAttempts}.`;
  } else if (freshness?.state === 'STALE') {
    tone = 'conn-down';
    label = 'STALE — ORDER ENTRY DISABLED';
    detail =
      `No market update for ${Math.round((freshness.ageMs ?? 0) / 1000)}s, which is ` +
      `${Math.round((freshness.excessMs ?? 0) / 1000)}s beyond this feed's expected delay.`;
  } else if (freshness?.state === 'MARKET_CLOSED') {
    tone = 'conn-delayed';
    label = 'MARKET CLOSED';
    detail = 'Outside the exchange session. Order entry is disabled.';
  } else if (freshness?.state === 'NO_DATA') {
    tone = 'conn-down';
    label = 'NO DATA';
    detail = 'The feed has not yet delivered a quote for this instrument.';
  } else if (mode === 'REPLAY') {
    tone = 'conn-replay';
    label = 'REPLAY';
    detail = 'Playing back a recorded real market session.';
  } else if (mode === 'REALTIME') {
    tone = 'conn-live';
    label = 'REAL-TIME';
    detail = 'Licensed real-time feed.';
  } else if (mode === 'DELAYED') {
    tone = 'conn-delayed';
    const minutes = Math.round((delaySeconds ?? 0) / 60);
    label = `DELAYED ${minutes}m`;
    detail =
      `Exchange-derived data, delayed ${delaySeconds}s (${minutes} minutes). ` +
      'This is NOT real-time and must not be treated as such.';
  }

  const latency = diagnostics?.latencyMs;

  return (
    <span className={`conn ${tone}`} title={detail}>
      <i />
      {label}
      {latency !== null && latency !== undefined && !socketDown ? (
        <em className="conn-latency">{latency}ms</em>
      ) : null}
    </span>
  );
}
