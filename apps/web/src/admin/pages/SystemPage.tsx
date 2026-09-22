/**
 * System health, told honestly.
 *
 * Green means green. The market-data row never shows HEALTHY merely because an
 * HTTP call returned: a delayed provider reads DELAYED, a stale one DEGRADED, a
 * disconnected one OFFLINE, from the provider's own connection state and the
 * age of its last print. The ~10-minute delayed feed is stated as such, not
 * dressed up as real-time.
 */
import type { JSX } from 'react';
import { adminApi } from '../api';
import { Panel, useLoad, when } from '../shared';
import type { AdminSystem } from '../types';

function tone(state: string): string {
  switch (state) {
    case 'HEALTHY':
      return 'adm-health-ok';
    case 'DELAYED':
      return 'adm-health-delayed';
    case 'DEGRADED':
      return 'adm-health-degraded';
    case 'NOT_CONFIGURED':
    case 'AWAITING_VALIDATION':
    case 'UNKNOWN':
      // Deliberately absent, not broken — a neutral dot, never alarm red.
      return 'adm-health-neutral';
    default:
      return 'adm-health-offline';
  }
}

function Row({
  label,
  state,
  detail,
}: {
  label: string;
  state: string;
  detail?: string;
}): JSX.Element {
  return (
    <div className="adm-health-row">
      <span className="adm-health-label">{label}</span>
      <span className={`adm-health-dot ${tone(state)}`} aria-hidden="true" />
      <span className="adm-health-state">{state}</span>
      <span className="adm-health-detail adm-dim">{detail ?? ''}</span>
    </div>
  );
}

export function AdminSystemPage(): JSX.Element {
  const { data, error, loading, reload } = useLoad<AdminSystem>(() => adminApi.system(), []);

  return (
    <div className="adm-page">
      <Panel
        title="System"
        action={
          <button className="adm-btn" onClick={reload}>
            Refresh
          </button>
        }
      >
        {error ? <p className="adm-error">Unable to load — {error}</p> : null}
        {!data && loading ? <p className="adm-muted">Loading…</p> : null}
        {data ? (
          <div className="adm-health">
            <Row label="API" state={data.api.state} />
            <Row label="Database" state={data.database.state} />
            <Row
              label="Market data"
              state={data.marketData.state}
              detail={[
                data.marketData.provider ?? 'provider',
                data.marketData.mode.toLowerCase(),
                data.marketData.delaySeconds
                  ? `~${Math.round(data.marketData.delaySeconds / 60)} min delayed`
                  : null,
                data.marketData.blocksOrderEntry ? 'order entry blocked' : null,
                data.marketData.lastQuoteExchangeTs
                  ? `last print ${when(data.marketData.lastQuoteExchangeTs)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <Row
              label="Audit chain"
              state={data.audit.state}
              detail={data.audit.state === 'HEALTHY' ? 'hash chain verified' : 'verification failed'}
            />
            {data.projections ? (
              <Row
                label="Projections"
                state={data.projections.state}
                detail={[
                  `${data.projections.total} accounts`,
                  data.projections.inconsistent > 0 ? `${data.projections.inconsistent} inconsistent` : 'all consistent',
                  data.projections.lastUpdatedAt ? `last ${when(data.projections.lastUpdatedAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ) : null}
            {data.outbox ? (
              <Row
                label="Outbox"
                state={data.outbox.state}
                detail={[
                  `${data.outbox.pending} pending`,
                  data.outbox.deadLetter > 0 ? `${data.outbox.deadLetter} dead-letter` : null,
                  data.outbox.oldestPendingAgeMs !== null
                    ? `oldest ${Math.round(data.outbox.oldestPendingAgeMs / 1000)}s`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ) : null}
            {data.payments ? (
              <Row
                label="Payments (Whop)"
                state={data.payments.state}
                detail={
                  data.payments.state === 'NOT_CONFIGURED'
                    ? 'sandbox credentials not configured'
                    : `${data.payments.environment ?? 'sandbox'} · awaiting authenticated validation`
                }
              />
            ) : null}
            <div className="adm-health-foot adm-dim">
              {data.build.nodeEnv}
              {data.build.version ? ` · ${data.build.version}` : ''} · checked {when(data.build.at)}
            </div>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
