/**
 * The products accounts are provisioned from.
 *
 * The catalogue: name, current version and headline terms. Opening a product
 * leads to the editor, where a SUPER_ADMIN drafts, previews and publishes a new
 * version - never editing an existing one, because accounts are pinned to the
 * version they were sold.
 */
import type { JSX } from 'react';
import { adminApi } from '../api';
import { Panel, StatusPill, useLoad, type AdminRouteGo } from '../shared';
import type { AdminProfile } from '../types';

export function AdminProductsPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const { data, error, loading } = useLoad<{ profiles: AdminProfile[] }>(
    () => adminApi.profiles(),
    [],
  );

  if (error) return <p className="adm-error">{error}</p>;
  if (!data) return <p className="adm-muted">{loading ? 'Loading…' : 'Nothing to show.'}</p>;

  return (
    <div className="adm-page">
      {data.profiles.map((profile) => {
        const rules = (profile.latestVersion?.config as { rules?: Record<string, number> } | null)
          ?.rules;
        return (
          <Panel
            key={profile.id}
            title={`${profile.name}  ·  ${profile.key}`}
            action={
              <span className="adm-row-actions">
                <StatusPill status={profile.status} />
                <span className="adm-dim">
                  {profile.latestVersion ? `version ${profile.latestVersion.version}` : 'no version'}
                </span>
                <button className="adm-btn" onClick={() => go({ name: 'PRODUCT', key: profile.key })}>
                  Open
                </button>
              </span>
            }
          >
            {rules ? (
              <dl className="adm-defs">
                <Def label="Account size" value={money(rules['accountSizeMicros'])} />
                <Def label="Profit target" value={money(rules['profitTargetMicros'])} />
                <Def label="Max loss" value={money(rules['maxLossMicros'])} />
                <Def label="Drawdown" value={String(rules['drawdownType'] ?? '—')} />
                <Def label="Daily loss limit" value={money(rules['dailyLossLimitMicros'])} />
                <Def label="Max contracts" value={String(rules['maxContracts'] ?? '—')} />
                <Def label="Min trading days" value={String(rules['minTradingDays'] ?? 0)} />
                <Def
                  label="Consistency"
                  value={
                    rules['consistencyThreshold']
                      ? `${Math.round(Number(rules['consistencyThreshold']) * 100)}%`
                      : 'none'
                  }
                />
              </dl>
            ) : (
              <p className="adm-muted">This product has no published version.</p>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function Def({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="adm-def">
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function money(micros: unknown): string {
  if (typeof micros !== 'number') return '—';
  return `$${(micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
