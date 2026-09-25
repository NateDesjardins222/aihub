/**
 * Infrastructure — the production-trading posture, told honestly (M4-Z).
 *
 * A read-only owner view of what Atlas is connected to and how it is
 * configured. Nothing here is settable from the browser, and nothing here is a
 * credential: an unconfigured professional provider reads UNCONFIGURED, never
 * CONNECTED, and the default execution mode is SIMULATION. This page exists so
 * an operator can SEE the boundary the whole milestone enforces — that Atlas is
 * simulation-first and provider-neutral — not to cross it.
 */
import type { JSX } from 'react';
import { adminApi } from '../api';
import { Panel, useLoad, when } from '../shared';
import type { AdminInfra, AdminProviderHealth } from '../types';

function healthTone(health: string): string {
  switch (health) {
    case 'CONNECTED':
      return 'adm-health-ok';
    case 'CONNECTING':
    case 'DEGRADED':
      return 'adm-health-degraded';
    case 'UNCONFIGURED':
      // Deliberately absent, not broken — a neutral dot, never alarm red.
      return 'adm-health-neutral';
    default:
      return 'adm-health-offline';
  }
}

function ProviderRow({ p }: { p: AdminProviderHealth }): JSX.Element {
  const detail = [
    p.kind,
    p.isSimulation ? 'simulation' : null,
    p.configState === 'UNCONFIGURED' ? 'unconfigured' : null,
    p.reconnectCount > 0 ? `${p.reconnectCount} reconnects` : null,
    p.lastMessageAt ? `last msg ${when(p.lastMessageAt)}` : null,
    p.lastError ? `error: ${p.lastError}` : null,
    p.detail || null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="adm-health-row">
      <span className="adm-health-label">
        {p.role === 'MARKET_DATA' ? 'Market data' : 'Execution'} — {p.providerId}
      </span>
      <span className={`adm-health-dot ${healthTone(p.health)}`} aria-hidden="true" />
      <span className="adm-health-state">{p.health}</span>
      <span className="adm-health-detail adm-dim">{detail}</span>
    </div>
  );
}

function PostureRow({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="adm-health-row">
      <span className="adm-health-label">{label}</span>
      <span className="adm-health-state">{value}</span>
      <span className="adm-health-detail adm-dim">{hint ?? ''}</span>
    </div>
  );
}

export function AdminInfraPage(): JSX.Element {
  const { data, error, loading, reload } = useLoad<AdminInfra>(() => adminApi.infra(), []);

  return (
    <div className="adm-page">
      <Panel
        title="Infrastructure"
        action={
          <button className="adm-btn" onClick={reload}>
            Refresh
          </button>
        }
      >
        {error ? <p className="adm-error">Unable to load — {error}</p> : null}
        {!data && loading ? <p className="adm-muted">Loading…</p> : null}
        {data ? (
          <>
            <p className="adm-muted" style={{ marginTop: 0 }}>
              Read-only. Execution routing and provider selection are server-side; this
              console cannot change them. Atlas is the P&amp;L authority for every mode.
            </p>
            <div className="adm-health">
              <PostureRow
                label="Default execution mode"
                value={data.posture.defaultExecutionMode}
                hint="every account, unless an admin maps it otherwise"
              />
              <PostureRow
                label="Configured execution provider"
                value={data.posture.configuredExecutionProvider}
                hint="the Atlas engine backs SIMULATION"
              />
              <PostureRow
                label="EXTERNAL_LIVE master gate"
                value={data.posture.externalLiveEnabled ? 'ENABLED' : 'DISABLED'}
                hint={data.posture.externalLiveEnabled ? 'live external orders permitted by config' : 'no live external order can be sent'}
              />
              <PostureRow
                label="Market-data provider"
                value={data.posture.marketDataProvider}
              />
              <PostureRow
                label="Market-data redistribution"
                value={data.posture.marketDataRedistribution}
                hint="declared compliance posture, not a capability"
              />
              <PostureRow
                label="Rithmic configuration"
                value={data.posture.rithmic.configState}
                hint={data.posture.rithmic.description}
              />
              <PostureRow
                label="Rithmic (R | Protocol)"
                value={data.posture.rithmic.enabled ? `${data.posture.rithmic.environment} · enabled` : 'disabled'}
                hint={
                  data.posture.rithmic.enabled
                    ? `system=${data.posture.rithmic.systemName ?? '—'} host=${data.posture.rithmic.endpointHost ?? '—'} · market-data ${data.posture.rithmic.marketDataEnabled ? 'on' : 'off'} · execution ${data.posture.rithmic.executionEnabled ? 'on' : 'off'}`
                    : 'Rithmic Test wire integration is off (RITHMIC_ENABLED=false)'
                }
              />
            </div>
          </>
        ) : null}
      </Panel>

      {data ? (
        <Panel title="Provider health">
          <div className="adm-health">
            {data.providers.map((p) => (
              <ProviderRow key={`${p.role}:${p.providerId}`} p={p} />
            ))}
          </div>
          <div className="adm-health-foot adm-dim">checked {when(data.generatedAt)}</div>
        </Panel>
      ) : null}
    </div>
  );
}
