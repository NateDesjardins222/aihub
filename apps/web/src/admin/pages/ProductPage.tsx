/**
 * The product editor.
 *
 * A product is a NAME; its terms live in immutable versions. This page never
 * edits a version - it composes a DRAFT, shows a field-level change preview
 * against the current published version, and publishes the draft as version
 * N+1. Accounts already trading version N keep version N; that guarantee is
 * enforced in the database, and this screen is built so an operator can see it
 * rather than take it on faith.
 *
 * Editing is SUPER_ADMIN. Everyone else sees the same information, read-only.
 */
import { Fragment, useMemo, useState, type JSX } from 'react';
import { adminApi } from '../api';
import { ConfirmAction, Panel, StatusPill, useLoad, when, type AdminRouteGo } from '../shared';
import type { AdminProductDetail, ProductConfig } from '../types';

const M = 1_000_000;

type Field =
  | { kind: 'money'; path: string; label: string; nullable?: boolean }
  | { kind: 'int'; path: string; label: string; nullable?: boolean }
  | { kind: 'pct'; path: string; label: string; nullable?: boolean }
  | { kind: 'enum'; path: string; label: string; options: readonly string[] }
  | { kind: 'bool'; path: string; label: string };

/**
 * The editable terms. This deliberately mirrors the server's own config schema
 * (profileConfigSchema): every field here is a field the engine consumes, so a
 * published version is exactly what was reviewed on screen.
 */
const FIELDS: readonly Field[] = [
  { kind: 'money', path: 'rules.accountSizeMicros', label: 'Account size' },
  { kind: 'money', path: 'rules.profitTargetMicros', label: 'Profit target' },
  { kind: 'money', path: 'rules.maxLossMicros', label: 'Max loss' },
  { kind: 'enum', path: 'rules.drawdownType', label: 'Drawdown type', options: ['STATIC', 'INTRADAY_TRAILING', 'EOD_TRAILING'] },
  { kind: 'money', path: 'rules.trailingLockAtMicros', label: 'Trailing lock at', nullable: true },
  { kind: 'money', path: 'rules.dailyLossLimitMicros', label: 'Daily loss limit', nullable: true },
  { kind: 'enum', path: 'rules.dailyLossPolicy', label: 'Daily loss policy', options: ['LOCK_DAY', 'FAIL'] },
  { kind: 'enum', path: 'rules.consistencyFormula', label: 'Consistency formula', options: ['BEST_DAY_OVER_TOTAL', 'BEST_DAY_OVER_TARGET'] },
  { kind: 'pct', path: 'rules.consistencyThreshold', label: 'Consistency threshold', nullable: true },
  { kind: 'int', path: 'rules.minTradingDays', label: 'Min trading days' },
  { kind: 'int', path: 'rules.minWinningDays', label: 'Min winning days' },
  { kind: 'int', path: 'rules.maxTradingDays', label: 'Max trading days', nullable: true },
  { kind: 'money', path: 'rules.minDailyPnlToCountMicros', label: 'Min daily P&L to count a day' },
  { kind: 'money', path: 'rules.minWinningDayPnlMicros', label: 'Min P&L for a winning day' },
  { kind: 'int', path: 'rules.maxContracts', label: 'Max contracts (rules)' },
  { kind: 'bool', path: 'rules.microsCountAsFraction', label: 'Partial contracts count' },
  { kind: 'bool', path: 'rules.flattenOnBreach', label: 'Flatten on breach' },
  { kind: 'int', path: 'instruments.maxContracts', label: 'Max contracts (account-wide)', nullable: true },
  { kind: 'money', path: 'display.startingBalanceMicros', label: 'Starting balance', nullable: true },
];

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]), obj);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const clone = structuredClone(obj);
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]!;
    cursor[key] = { ...(cursor[key] as Record<string, unknown> | undefined) };
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]!] = value;
  return clone;
}

function display(field: Field, raw: unknown): string {
  if (raw === null || raw === undefined) return 'none';
  switch (field.kind) {
    case 'money':
      return `$${(Number(raw) / M).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    case 'pct':
      return `${Math.round(Number(raw) * 100)}%`;
    case 'bool':
      return raw ? 'yes' : 'no';
    default:
      return String(raw);
  }
}

interface Change {
  label: string;
  from: string;
  to: string;
}

/** Every field whose formatted value differs between two configs. */
function diff(base: ProductConfig | null, next: ProductConfig): Change[] {
  const changes: Change[] = [];
  for (const field of FIELDS) {
    const to = display(field, getPath(next, field.path));
    const from = base ? display(field, getPath(base, field.path)) : '—';
    if (from !== to) changes.push({ label: field.label, from, to });
  }
  return changes;
}

export function AdminProductPage({
  productKey,
  go,
  maySuper,
}: {
  productKey: string;
  go: AdminRouteGo;
  maySuper: boolean;
}): JSX.Element {
  const { data, error, loading, reload } = useLoad<AdminProductDetail>(
    () => adminApi.product(productKey),
    [productKey],
  );

  if (error) {
    return (
      <div className="adm-page">
        <Panel title="Product">
          <p className="adm-error">Unable to load — {error}</p>
          <button className="adm-btn" onClick={() => go({ name: 'PRODUCTS' })}>
            Back to products
          </button>
        </Panel>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="adm-page">
        <Panel title="Product">
          <p className="adm-muted">{loading ? 'Loading…' : 'No data.'}</p>
        </Panel>
      </div>
    );
  }

  // Remount (and reseed the form) whenever the published set or the draft
  // changes underneath us - after a publish, save or discard - so the editor
  // and its change preview always reflect the server's current truth rather
  // than a stale working copy.
  const seedKey = `${data.versions.length}:${data.draft?.id ?? 'none'}:${data.draft?.updatedAt ?? 0}`;
  return (
    <ProductEditor key={seedKey} detail={data} go={go} maySuper={maySuper} onChanged={reload} />
  );
}

function ProductEditor({
  detail,
  go,
  maySuper,
  onChanged,
}: {
  detail: AdminProductDetail;
  go: AdminRouteGo;
  maySuper: boolean;
  onChanged: () => void;
}): JSX.Element {
  const currentVersion = detail.versions[0] ?? null;
  const baseConfig = currentVersion?.config ?? null;
  const seed = detail.draft?.config ?? baseConfig;

  const [working, setWorking] = useState<ProductConfig>(() =>
    seed ? structuredClone(seed) : emptyConfig(),
  );
  const [name, setName] = useState(detail.draft?.name ?? detail.profile?.name ?? '');
  const [notes, setNotes] = useState(detail.draft?.notes ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<null | 'retire' | 'reactivate'>(null);

  const changes = useMemo(() => diff(baseConfig, working), [baseConfig, working]);
  const dirty =
    changes.length > 0 ||
    name !== (detail.profile?.name ?? '') ||
    notes !== (detail.draft?.notes ?? '');
  const staleDraft =
    detail.draft?.baseVersion != null &&
    currentVersion != null &&
    detail.draft.baseVersion !== currentVersion.version;

  const set = (path: string, value: unknown): void =>
    setWorking((cfg) => setPath(cfg as unknown as Record<string, unknown>, path, value) as unknown as ProductConfig);

  async function run(kind: string, fn: () => Promise<void>): Promise<void> {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ tone: 'err', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const saveDraft = (): Promise<void> =>
    run('save', async () => {
      await adminApi.saveDraft(detail.profile?.key ?? detail.draft!.key, {
        name,
        accountType: detail.profile?.accountType ?? detail.draft?.accountType ?? 'EVALUATION',
        notes: notes || null,
        config: working,
      });
      setMsg({ tone: 'ok', text: 'Draft saved.' });
      onChanged();
    });

  const discardDraft = (): Promise<void> =>
    run('discard', async () => {
      await adminApi.discardDraft(detail.profile?.key ?? detail.draft!.key);
      setMsg({ tone: 'ok', text: 'Draft discarded.' });
      onChanged();
    });

  const publish = (): Promise<void> =>
    run('publish', async () => {
      // Publishing always publishes the persisted draft, so save first if the
      // on-screen edit has not been written yet.
      if (dirty || !detail.draft) await saveOnly();
      const res = await adminApi.publishDraft(detail.profile?.key ?? detail.draft!.key);
      setMsg({ tone: 'ok', text: `Published version ${res.version}.` });
      onChanged();
    });

  async function saveOnly(): Promise<void> {
    await adminApi.saveDraft(detail.profile?.key ?? detail.draft!.key, {
      name,
      accountType: detail.profile?.accountType ?? detail.draft?.accountType ?? 'EVALUATION',
      notes: notes || null,
      config: working,
    });
  }

  const setStatus = (status: 'ACTIVE' | 'RETIRED', reason: string): Promise<void> =>
    run('status', async () => {
      await adminApi.setProductStatus(detail.profile!.key, status, reason);
      setConfirm(null);
      setMsg({ tone: 'ok', text: status === 'RETIRED' ? 'Product retired.' : 'Product reactivated.' });
      onChanged();
    });

  const profile = detail.profile;
  const readOnly = !maySuper;

  return (
    <div className="adm-page">
      <Panel
        title={`${profile?.name ?? (name || detail.draft?.key)} · ${profile?.key ?? detail.draft?.key}`}
        action={
          <span className="adm-row-actions">
            {profile ? <StatusPill status={profile.status} /> : <span className="adm-pill">draft only</span>}
            <button className="adm-btn" onClick={() => go({ name: 'PRODUCTS' })}>
              Back
            </button>
            {maySuper && profile ? (
              profile.status === 'ACTIVE' ? (
                <button className="adm-btn adm-btn-danger" onClick={() => setConfirm('retire')}>
                  Retire
                </button>
              ) : (
                <button className="adm-btn" onClick={() => setConfirm('reactivate')}>
                  Reactivate
                </button>
              )
            ) : null}
          </span>
        }
      >
        <p className="adm-note">
          {currentVersion
            ? `Current published version ${currentVersion.version}, published ${when(currentVersion.publishedAt)}.`
            : 'Not yet published — this product exists only as a draft.'}
          {detail.draft ? ' A draft is in progress.' : ''}
        </p>
        {staleDraft ? (
          <p className="adm-error">
            This draft was started from version {detail.draft!.baseVersion}, but version{' '}
            {currentVersion!.version} has since been published. Review the change preview before
            publishing.
          </p>
        ) : null}
        {msg ? <p className={msg.tone === 'ok' ? 'adm-ok' : 'adm-error'}>{msg.text}</p> : null}
      </Panel>

      <div className="adm-grid-2">
        <Panel title="Terms">
          <label className="adm-field">
            <span>Display name</span>
            <input value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="adm-form-grid">
            {FIELDS.map((field) => (
              <FieldInput
                key={field.path}
                field={field}
                value={getPath(working, field.path)}
                readOnly={readOnly}
                onChange={(v) => set(field.path, v)}
              />
            ))}
          </div>
        </Panel>

        <div>
          <Panel title="Change preview">
            <p className="adm-note">
              {currentVersion
                ? `Draft compared with published version ${currentVersion.version}.`
                : 'A brand-new product. Every term below is new.'}
            </p>
            {changes.length === 0 ? (
              <p className="adm-muted">No changes from the current version.</p>
            ) : (
              <table className="adm-table adm-diff">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th className="num">From</th>
                    <th className="num">To</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.label}>
                      <td>{c.label}</td>
                      <td className="num adm-dim">{c.from}</td>
                      <td className="num adm-diff-to">{c.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {maySuper ? (
              <>
                <label className="adm-field">
                  <span>Notes for this version (optional)</span>
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What changed and why" />
                </label>
                <div className="adm-dialog-actions">
                  <button className="adm-btn" disabled={!dirty || busy !== null} onClick={saveDraft}>
                    {busy === 'save' ? 'Saving…' : 'Save draft'}
                  </button>
                  {detail.draft ? (
                    <button className="adm-btn" disabled={busy !== null} onClick={discardDraft}>
                      {busy === 'discard' ? 'Discarding…' : 'Discard draft'}
                    </button>
                  ) : null}
                  <button
                    className="adm-btn adm-btn-primary"
                    disabled={busy !== null || (changes.length === 0 && !detail.draft)}
                    onClick={publish}
                  >
                    {busy === 'publish' ? 'Publishing…' : `Publish version ${(currentVersion?.version ?? 0) + 1}`}
                  </button>
                </div>
                <p className="adm-note adm-dim">
                  Publishing writes a new version. Accounts already on version{' '}
                  {currentVersion?.version ?? '—'} are not affected.
                </p>
              </>
            ) : (
              <p className="adm-muted">Editing a product requires the SUPER ADMIN role.</p>
            )}
          </Panel>
        </div>
      </div>

      <Panel title="Version history">
        {detail.versions.length === 0 ? (
          <p className="adm-muted">No versions published yet.</p>
        ) : (
          <VersionHistory detail={detail} />
        )}
      </Panel>

      {confirm ? (
        <ConfirmAction
          title={confirm === 'retire' ? 'Retire this product' : 'Reactivate this product'}
          description={
            confirm === 'retire'
              ? 'New accounts can no longer be provisioned from this product. Accounts already trading it keep their terms.'
              : 'This product can be provisioned from again.'
          }
          confirmLabel={confirm === 'retire' ? 'Retire' : 'Reactivate'}
          busy={busy === 'status'}
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => setStatus(confirm === 'retire' ? 'RETIRED' : 'ACTIVE', reason)}
        />
      ) : null}
    </div>
  );
}

/** The version list, each row expandable to a diff against the previous version. */
function VersionHistory({ detail }: { detail: AdminProductDetail }): JSX.Element {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <table className="adm-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Published</th>
          <th>Account size</th>
          <th>Profit target</th>
          <th>Max loss</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {detail.versions.map((v, i) => {
          const prev = detail.versions[i + 1]?.config ?? null;
          const changes = diff(prev, v.config);
          return (
            <Fragment key={v.id}>
              <tr className="adm-row-click" onClick={() => setOpen(open === v.version ? null : v.version)}>
                <td>
                  v{v.version}
                  {i === 0 ? <span className="adm-dim"> (current)</span> : null}
                </td>
                <td className="num adm-dim">{when(v.publishedAt)}</td>
                <td className="num">{money(v.config.rules.accountSizeMicros)}</td>
                <td className="num">{money(v.config.rules.profitTargetMicros)}</td>
                <td className="num">{money(v.config.rules.maxLossMicros)}</td>
                <td className="num adm-dim">
                  {prev ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'first version'}
                </td>
              </tr>
              {open === v.version ? (
                <tr>
                  <td colSpan={6}>
                    {v.notes ? <p className="adm-note">Notes: {v.notes}</p> : null}
                    {changes.length === 0 ? (
                      <p className="adm-muted">
                        {prev ? 'No term changed from the previous version.' : 'The first version.'}
                      </p>
                    ) : (
                      <table className="adm-table adm-diff">
                        <tbody>
                          {changes.map((c) => (
                            <tr key={c.label}>
                              <td>{c.label}</td>
                              <td className="num adm-dim">{c.from}</td>
                              <td className="num adm-diff-to">{c.to}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function FieldInput({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: Field;
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}): JSX.Element {
  const isNull = value === null || value === undefined;

  if (field.kind === 'bool') {
    return (
      <label className="adm-field adm-field-inline">
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    );
  }

  if (field.kind === 'enum') {
    return (
      <label className="adm-field">
        <span>{field.label}</span>
        <select value={String(value)} disabled={readOnly} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt.replace(/_/g, ' ').toLowerCase()}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const shown =
    isNull
      ? ''
      : field.kind === 'money'
        ? String(Number(value) / M)
        : field.kind === 'pct'
          ? String(Math.round(Number(value) * 100))
          : String(value);

  const commit = (text: string): void => {
    if (text.trim() === '') {
      onChange(field.nullable ? null : 0);
      return;
    }
    const n = Number(text);
    if (Number.isNaN(n)) return;
    if (field.kind === 'money') onChange(Math.round(n * M));
    else if (field.kind === 'pct') onChange(n / 100);
    else onChange(Math.round(n));
  };

  return (
    <label className="adm-field">
      <span>
        {field.label}
        {field.kind === 'money' ? ' ($)' : field.kind === 'pct' ? ' (%)' : ''}
        {field.nullable ? <span className="adm-dim"> · blank = none</span> : null}
      </span>
      <input
        inputMode="decimal"
        value={shown}
        disabled={readOnly}
        placeholder={field.nullable ? 'none' : ''}
        onChange={(e) => commit(e.target.value)}
      />
    </label>
  );
}

function money(micros: number): string {
  return `$${(micros / M).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function emptyConfig(): ProductConfig {
  return {
    rules: {
      accountSizeMicros: 50_000 * M,
      profitTargetMicros: 3_000 * M,
      maxLossMicros: 2_000 * M,
      drawdownType: 'STATIC',
      trailingLockAtMicros: null,
      dailyLossLimitMicros: null,
      dailyLossPolicy: 'LOCK_DAY',
      consistencyFormula: 'BEST_DAY_OVER_TOTAL',
      consistencyThreshold: null,
      minTradingDays: 0,
      minWinningDays: 0,
      maxTradingDays: null,
      minDailyPnlToCountMicros: 0,
      minWinningDayPnlMicros: 1,
      maxContracts: 5,
      microsCountAsFraction: true,
      flattenOnBreach: true,
    },
    execution: null,
    instruments: { allowed: null, maxContracts: null, perInstrument: {} },
    display: {},
    payoutRules: null,
  };
}
