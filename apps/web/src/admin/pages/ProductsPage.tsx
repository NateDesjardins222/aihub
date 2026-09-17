/**
 * The products accounts are provisioned from.
 *
 * Read-only here on purpose: publishing a version is a SUPER_ADMIN action with
 * consequences for every account provisioned afterwards, and it is done
 * through the API with a reviewed configuration rather than typed into a form
 * at speed. What this page is for is answering "what terms did we sell, and
 * which version is current".
 */
import type { JSX } from 'react';
import { adminApi } from '../api';
import { Panel, useLoad } from '../shared';
import type { AdminProfile } from '../types';

export function AdminProductsPage(): JSX.Element {
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
              <span className="adm-dim">
                {profile.latestVersion ? `version ${profile.latestVersion.version}` : 'no version'}
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
