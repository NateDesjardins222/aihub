/**
 * V2 personal risk controls (Product Rebuild Phase 2, Part VIII — launch-critical).
 *
 * This USES the existing, behaviourally-verified personal-risk system — it does not
 * recreate it. Every mutation goes through the same authoritative endpoints as V1:
 *
 *   GET  /api/v1/portal/accounts/:id/controls              → PersonalRiskProfileView
 *   PUT  /api/v1/portal/accounts/:id/controls/:controlType → { enabled, mode, value, expectedVersion }
 *
 * The server owns all enforcement: personal controls may only make an account
 * MORE restrictive, never weaken a firm rule, and LOCKED controls are tighten-only
 * until the next trading day. The client sends intent and RECONCILES to the
 * authoritative response; on any rejection it reloads the server truth (no fake
 * "Saved"). Optimistic concurrency uses the control's `expectedVersion`.
 *
 * Presentation only is V2; the risk semantics are unchanged from V1.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { api } from '../../api/client';
import type { PersonalControlValue, PersonalControlView, PersonalRiskProfileView } from '@atlas/contracts';
import { V2Button } from './primitives';
import { formatMoney } from './format';

const M = 1_000_000;

const META: Record<string, { name: string; desc: string }> = {
  DAILY_LOSS_LIMIT: { name: 'Daily Loss Limit', desc: 'Stop opening new trades once today’s realized loss reaches this amount.' },
  MAX_TRADES: { name: 'Max Trades Per Day', desc: 'Cap how many new trades you open in a trading day.' },
  DAILY_DRAWDOWN: { name: 'Daily Drawdown Limit', desc: 'Stop new exposure once equity falls this far from today’s high-water.' },
  MAX_POSITION: { name: 'Max Position Size', desc: 'Cap your open contracts (never above the firm maximum).' },
  DAILY_CONTRACT_LIMIT: { name: 'Max Contracts Per Day', desc: 'Cap the total contracts you open across the day.' },
  PROFIT_LOCK: { name: 'Daily Profit Lock', desc: 'Lock in today’s gains — block new exposure once profit reaches this.' },
  CONSECUTIVE_LOSS_LOCK: { name: 'Consecutive Loss Lock', desc: 'Stop after this many losing trades in a row.' },
  COOLDOWN: { name: 'Loss Cooldown', desc: 'After a losing trade closes, pause new exposure for this many minutes.' },
  TRADING_WINDOW: { name: 'Trading Window', desc: 'Only allow new trades between these exchange-time hours.' },
  SESSION_RESTRICTION: { name: 'Session Restriction', desc: 'Only allow new trades during the chosen market sessions.' },
};

const SESSIONS = ['OPEN', 'PRE_OPEN', 'MAINTENANCE', 'CLOSED'];

type Notice = { kind: 'ok' | 'err'; text: string } | null;

export function V2AccountControls({ accountId }: { accountId: string }): JSX.Element {
  const [profile, setProfile] = useState<PersonalRiskProfileView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(() => {
    setErr(null);
    void api
      .get<PersonalRiskProfileView>(`/api/v1/portal/accounts/${accountId}/controls`)
      .then((p) => setProfile(p))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load risk controls.'));
  }, [accountId]);
  useEffect(load, [load]);

  if (err) {
    return (
      <div className="htv2-detail-error" role="alert" data-testid="htv2-controls-error">
        <div className="ht-t-section">We couldn’t load your risk controls</div>
        <p className="ht-t-body-sm">{err}</p>
        <V2Button variant="secondary" size="sm" onClick={load}>Try again</V2Button>
      </div>
    );
  }
  if (!profile) {
    return <div className="htv2-detail-skeleton" data-testid="htv2-controls-loading" aria-busy="true"><span /><span /><span /></div>;
  }

  return (
    <div data-testid="htv2-controls">
      <p className="ht-t-body-sm htv2-controls-note">
        Personal controls make an account <strong>more</strong> restrictive — never less. Firm rules always win, and every
        control is enforced on the server, not the browser. Trading day: <span className="ht-num">{profile.tradingDay ?? 'unknown'}</span>.
      </p>
      {!profile.editable && (
        <div className="htv2-controls-blocked" role="status" data-testid="htv2-controls-blocked">
          This account cannot change risk controls in its current state.
        </div>
      )}
      {notice && (
        <div className={`htv2-controls-notice ${notice.kind}`} role="status" data-testid="htv2-controls-notice">{notice.text}</div>
      )}
      <div className="htv2-controls-list">
        {profile.controls.map((c) => (
          <ControlRow
            key={c.controlType}
            c={c}
            editable={profile.editable}
            accountId={accountId}
            onSaved={(p) => { setNotice({ kind: 'ok', text: 'Control saved' }); setProfile(p); }}
            onError={(m) => setNotice({ kind: 'err', text: m })}
            reload={load}
          />
        ))}
      </div>
    </div>
  );
}

function ControlRow({
  c, editable, accountId, onSaved, onError, reload,
}: {
  c: PersonalControlView; editable: boolean; accountId: string;
  onSaved: (p: PersonalRiskProfileView) => void; onError: (m: string) => void; reload: () => void;
}): JSX.Element {
  const meta = META[c.controlType] ?? { name: c.controlType, desc: '' };
  const [draft, setDraft] = useState<PersonalControlValue>(valueOf(c));
  const [enabled, setEnabled] = useState(c.enabled);
  const [confirmLock, setConfirmLock] = useState(false);
  const [busy, setBusy] = useState(false);
  // Reconcile local editor state whenever the authoritative control changes.
  useEffect(() => { setDraft(valueOf(c)); setEnabled(c.enabled); }, [c]);

  const put = async (body: { enabled: boolean; mode: 'FLEXIBLE' | 'LOCKED'; value: PersonalControlValue }): Promise<void> => {
    setBusy(true);
    try {
      // Optimistic concurrency: the server rejects a stale expectedVersion.
      await api.put(`/api/v1/portal/accounts/${accountId}/controls/${c.controlType}`, { ...body, expectedVersion: c.version });
      const p = await api.get<PersonalRiskProfileView>(`/api/v1/portal/accounts/${accountId}/controls`);
      onSaved(p);
    } catch (e) {
      // On ANY rejection, reload authoritative truth — never leave a fake success.
      onError(e instanceof Error ? e.message : 'That change was rejected.');
      reload();
    } finally {
      setBusy(false);
    }
  };

  const disabledEditing = !editable || busy;
  return (
    <div className={`htv2-ctl${c.locked ? ' locked' : ''}`} data-testid={`htv2-ctl-${c.controlType}`}>
      <div className="htv2-ctl-head">
        <div className="htv2-ctl-name ht-t-body">{meta.name}</div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${meta.name} ${enabled ? 'on' : 'off'}`}
          className={`htv2-switch${enabled ? ' on' : ''}`}
          disabled={disabledEditing || c.locked}
          onClick={() => {
            const next = !enabled; // the switch enables a control — typing a value never does
            setEnabled(next);
            void put({ enabled: next, mode: c.locked ? 'LOCKED' : c.mode, value: draft });
          }}
        >
          <span className="htv2-switch-track"><span className="htv2-switch-thumb" /></span>
          <span className="htv2-switch-label ht-t-meta">{enabled ? 'On' : 'Off'}</span>
        </button>
      </div>
      <div className="htv2-ctl-desc ht-t-meta">{meta.desc}</div>

      <ValueEditor kind={c.kind} value={draft} onChange={setDraft} disabled={disabledEditing} label={meta.name} />

      <div className="htv2-ctl-actions">
        <V2Button variant="secondary" size="sm" disabled={disabledEditing} onClick={() => void put({ enabled, mode: c.locked ? 'LOCKED' : c.mode, value: draft })}>Save value</V2Button>
        {!c.locked && enabled && <V2Button variant="tertiary" size="sm" disabled={disabledEditing} onClick={() => setConfirmLock(true)}>Lock until next trading day</V2Button>}
      </div>

      {c.usage && enabled && <Usage type={c.controlType} usage={c.usage} />}

      {c.locked && (
        <div className="htv2-ctl-lock" data-testid="htv2-ctl-locked">
          <span className="htv2-ctl-lockbadge ht-t-meta">🔒 Locked until next trading day</span>
          <span className="ht-t-meta">You may make it stricter, but not looser, until then.</span>
        </div>
      )}

      {confirmLock && (
        <div className="htv2-ctl-lockconfirm">
          <strong className="ht-t-body-sm">Lock this control?</strong>
          <span className="ht-t-meta">You will be able to make this rule stricter, but not loosen or disable it until the next trading day.</span>
          <div className="htv2-ctl-actions">
            <V2Button variant="secondary" size="sm" onClick={() => setConfirmLock(false)}>Cancel</V2Button>
            <V2Button variant="primary" size="sm" testId="htv2-lock-confirm" onClick={() => { setConfirmLock(false); void put({ enabled: true, mode: 'LOCKED', value: draft }); }}>Lock</V2Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ValueEditor({ kind, value, onChange, disabled, label }: { kind: string; value: PersonalControlValue; onChange: (v: PersonalControlValue) => void; disabled: boolean; label: string }): JSX.Element {
  if (kind === 'MICROS') {
    const dollars = value.valueMicros != null ? value.valueMicros / M : '';
    return (
      <div className="htv2-ctl-value">
        <span className="htv2-ctl-dim" aria-hidden>$</span>
        <input className="htv2-input ht-num" type="number" min={0} step={50} value={dollars} disabled={disabled} aria-label={`${label} (dollars)`}
          onChange={(e) => onChange({ valueMicros: e.target.value === '' ? null : Math.round(Number(e.target.value) * M) })} />
      </div>
    );
  }
  if (kind === 'INT') {
    return (
      <div className="htv2-ctl-value">
        <input className="htv2-input ht-num" type="number" min={1} step={1} value={value.valueInt ?? ''} disabled={disabled} aria-label={label}
          onChange={(e) => onChange({ valueInt: e.target.value === '' ? null : Math.round(Number(e.target.value)) })} />
      </div>
    );
  }
  if (kind === 'WINDOW') {
    return (
      <div className="htv2-ctl-value">
        <input className="htv2-input" type="time" value={value.windowStart ?? ''} disabled={disabled} aria-label={`${label} start`} onChange={(e) => onChange({ ...value, windowStart: e.target.value })} />
        <span className="htv2-ctl-dim" aria-hidden>to</span>
        <input className="htv2-input" type="time" value={value.windowEnd ?? ''} disabled={disabled} aria-label={`${label} end`} onChange={(e) => onChange({ ...value, windowEnd: e.target.value })} />
      </div>
    );
  }
  const set = new Set(value.sessions ?? []);
  return (
    <div className="htv2-ctl-value htv2-ctl-sessions">
      {SESSIONS.map((s) => (
        <label key={s} className="htv2-ctl-session">
          <input type="checkbox" disabled={disabled} checked={set.has(s)} onChange={(e) => {
            const next = new Set(set); if (e.target.checked) next.add(s); else next.delete(s);
            onChange({ sessions: [...next] });
          }} />
          {s.replace('_', ' ')}
        </label>
      ))}
    </div>
  );
}

function Usage({ type, usage }: { type: string; usage: Readonly<Record<string, unknown>> }): JSX.Element {
  const u = usage as Record<string, number | boolean | null>;
  let text = '';
  switch (type) {
    case 'MAX_TRADES': text = `Today: ${u.used ?? 0} / ${u.limit ?? '—'} used`; break;
    case 'DAILY_CONTRACT_LIMIT': text = `Today: ${u.used ?? 0} / ${u.limit ?? '—'} contracts`; break;
    case 'CONSECUTIVE_LOSS_LOCK': text = `Streak: ${u.current ?? 0} / ${u.limit ?? '—'}`; break;
    case 'DAILY_LOSS_LIMIT': text = `Today: ${formatMoney((u.usedMicros as number) ?? 0)} of ${formatMoney((u.limitMicros as number) ?? null)}`; break;
    case 'PROFIT_LOCK': text = `Today: ${formatMoney((u.progressMicros as number) ?? 0)} toward ${formatMoney((u.thresholdMicros as number) ?? null)}${u.triggered ? ' — locked' : ''}`; break;
    case 'DAILY_DRAWDOWN': text = u.drawdownMicros != null ? `Drawdown: ${formatMoney(u.drawdownMicros as number)} of ${formatMoney((u.limitMicros as number) ?? null)}` : 'Drawdown reference forming.'; break;
    case 'COOLDOWN': {
      const ms = (u.remainingMs as number) ?? 0;
      text = ms > 0 ? `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s remaining` : 'No active cooldown';
      break;
    }
    case 'TRADING_WINDOW': text = `Window ${u.windowStart ?? '—'}–${u.windowEnd ?? '—'} (exchange time)`; break;
    case 'SESSION_RESTRICTION': text = `Allowed: ${((usage.allowed as string[]) ?? []).join(', ') || '—'}`; break;
    default: text = '';
  }
  return <div className="htv2-ctl-usage ht-t-meta" data-testid="htv2-ctl-usage">{text}</div>;
}

function valueOf(c: PersonalControlView): PersonalControlValue {
  return { valueMicros: c.valueMicros ?? null, valueInt: c.valueInt ?? null, windowStart: c.windowStart ?? null, windowEnd: c.windowEnd ?? null, sessions: c.sessions ?? null };
}
