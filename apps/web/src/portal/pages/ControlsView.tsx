import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../../api/client';
import { Card, money, msg, Skeleton, Toggle } from '../lib';
import type { PersonalControlView, PersonalRiskProfileView, PersonalControlValue } from '@atlas/contracts';

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

export function ControlsView({ accountId, onToast }: { accountId: string; onToast: (m: string) => void }): JSX.Element {
  const [profile, setProfile] = useState<PersonalRiskProfileView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void api.get<PersonalRiskProfileView>(`/api/v1/portal/accounts/${accountId}/controls`).then(setProfile).catch((e: unknown) => setErr(msg(e)));
  }, [accountId]);
  useEffect(load, [load]);

  if (err) return <p className="pt-error">{err}</p>;
  if (!profile) return <Skeleton h={140} />;

  return (
    <>
      <p className="pt-sub" style={{ marginTop: 0 }}>
        Personal controls make an account <strong>more</strong> restrictive — never less. Firm rules always win, and every
        control is enforced on the server, not the browser. Trading day: {profile.tradingDay ?? 'unknown'}.
      </p>
      {!profile.editable && <div className="pt-blocked">This account cannot change risk controls in its current state.</div>}
      <div style={{ display: 'grid', gap: 14, marginTop: 16 }}>
        {profile.controls.map((c) => (
          <ControlRow key={c.controlType} c={c} editable={profile.editable} onSaved={(p) => { onToast('Control saved'); setProfile(p); }} onError={onToast} accountId={accountId} reload={load} />
        ))}
      </div>
    </>
  );
}

function ControlRow({
  c, editable, accountId, onSaved, onError, reload,
}: {
  c: PersonalControlView; editable: boolean; accountId: string;
  onSaved: (p: PersonalRiskProfileView) => void; onError: (m: string) => void; reload: () => void;
}): JSX.Element {
  const meta = META[c.controlType]!;
  const [draft, setDraft] = useState<PersonalControlValue>(valueOf(c));
  const [enabled, setEnabled] = useState(c.enabled);
  const [confirmLock, setConfirmLock] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(valueOf(c)); setEnabled(c.enabled); }, [c]);

  const put = async (body: { enabled: boolean; mode: 'FLEXIBLE' | 'LOCKED'; value: PersonalControlValue }): Promise<void> => {
    setBusy(true);
    try {
      await api.put(`/api/v1/portal/accounts/${accountId}/controls/${c.controlType}`, { ...body, expectedVersion: c.version });
      const p = await api.get<PersonalRiskProfileView>(`/api/v1/portal/accounts/${accountId}/controls`);
      onSaved(p);
    } catch (e) { onError(msg(e)); reload(); } finally { setBusy(false); }
  };

  const disabledEditing = !editable || busy;
  return (
    <div className={`pt-ctl${c.locked ? ' locked' : ''}`} data-testid={`pt-ctl-${c.controlType}`}>
      <div className="pt-ctl-head">
        <div><div className="pt-ctl-name">{meta.name}</div></div>
        <Toggle
          on={enabled}
          disabled={disabledEditing || c.locked}
          label={enabled ? 'On' : 'Off'}
          onClick={() => {
            // The switch is what enables a control — typing a value never does.
            const next = !enabled;
            setEnabled(next);
            void put({ enabled: next, mode: c.locked ? 'LOCKED' : c.mode, value: draft });
          }}
        />
      </div>
      <div className="pt-ctl-desc">{meta.desc}</div>

      <ValueEditor kind={c.kind} value={draft} onChange={setDraft} disabled={disabledEditing} />

      <div className="pt-actions" style={{ marginTop: 6 }}>
        <button className="pt-btn" disabled={disabledEditing} onClick={() => void put({ enabled, mode: c.locked ? 'LOCKED' : c.mode, value: draft })}>Save value</button>
        {!c.locked && enabled && <button className="pt-link" disabled={disabledEditing} onClick={() => setConfirmLock(true)}>Lock until next trading day</button>}
      </div>

      {c.usage && enabled && <Usage type={c.controlType} usage={c.usage} />}

      {c.locked && (
        <div className="pt-ctl-lock">
          <span className="pt-ctl-lockbadge" data-testid="pt-locked">🔒 LOCKED UNTIL NEXT TRADING DAY</span>
          <span className="pt-note" style={{ margin: 0 }}>You may make it stricter, but not looser, until {c.lockedTradingDay ? 'the next trading day' : 'then'}.</span>
        </div>
      )}

      {confirmLock && (
        <LockConfirm
          onCancel={() => setConfirmLock(false)}
          onConfirm={() => { setConfirmLock(false); void put({ enabled: true, mode: 'LOCKED', value: draft }); }}
        />
      )}
    </div>
  );
}

function ValueEditor({ kind, value, onChange, disabled }: { kind: string; value: PersonalControlValue; onChange: (v: PersonalControlValue) => void; disabled: boolean }): JSX.Element {
  if (kind === 'MICROS') {
    const dollars = value.valueMicros != null ? value.valueMicros / M : '';
    return (
      <div className="pt-ctl-value">
        <span className="pt-dim">$</span>
        <input className="pt-input num" type="number" min={0} step={50} value={dollars} disabled={disabled}
          onChange={(e) => onChange({ valueMicros: e.target.value === '' ? null : Math.round(Number(e.target.value) * M) })} />
      </div>
    );
  }
  if (kind === 'INT') {
    return (
      <div className="pt-ctl-value">
        <input className="pt-input num" type="number" min={1} step={1} value={value.valueInt ?? ''} disabled={disabled}
          onChange={(e) => onChange({ valueInt: e.target.value === '' ? null : Math.round(Number(e.target.value)) })} />
      </div>
    );
  }
  if (kind === 'WINDOW') {
    return (
      <div className="pt-ctl-value">
        <input className="pt-input" type="time" value={value.windowStart ?? ''} disabled={disabled} onChange={(e) => onChange({ ...value, windowStart: e.target.value })} style={{ maxWidth: 130 }} />
        <span className="pt-dim">to</span>
        <input className="pt-input" type="time" value={value.windowEnd ?? ''} disabled={disabled} onChange={(e) => onChange({ ...value, windowEnd: e.target.value })} style={{ maxWidth: 130 }} />
      </div>
    );
  }
  // SESSIONS
  const set = new Set(value.sessions ?? []);
  return (
    <div className="pt-ctl-value" style={{ flexWrap: 'wrap' }}>
      {SESSIONS.map((s) => (
        <label key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
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

function Usage({ type, usage }: { type: string; usage: Record<string, unknown> }): JSX.Element {
  const u = usage as Record<string, number | boolean | null>;
  let text = '';
  switch (type) {
    case 'MAX_TRADES': text = `Today: ${u.used ?? 0} / ${u.limit ?? '—'} used`; break;
    case 'DAILY_CONTRACT_LIMIT': text = `Today: ${u.used ?? 0} / ${u.limit ?? '—'} contracts`; break;
    case 'CONSECUTIVE_LOSS_LOCK': text = `Streak: ${u.current ?? 0} / ${u.limit ?? '—'}`; break;
    case 'DAILY_LOSS_LIMIT': text = `Today: ${money((u.usedMicros as number) ?? 0)} of ${money((u.limitMicros as number) ?? null)}`; break;
    case 'PROFIT_LOCK': text = `Today: ${money((u.progressMicros as number) ?? 0)} toward ${money((u.thresholdMicros as number) ?? null)}${u.triggered ? ' — locked' : ''}`; break;
    case 'DAILY_DRAWDOWN': text = u.drawdownMicros != null ? `Drawdown: ${money(u.drawdownMicros as number)} of ${money((u.limitMicros as number) ?? null)}` : 'Drawdown reference forming.'; break;
    case 'COOLDOWN': {
      const ms = (u.remainingMs as number) ?? 0;
      text = ms > 0 ? `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s remaining` : 'No active cooldown';
      break;
    }
    case 'TRADING_WINDOW': text = `Window ${u.windowStart ?? '—'}–${u.windowEnd ?? '—'} (exchange time)`; break;
    case 'SESSION_RESTRICTION': text = `Allowed: ${((usage.allowed as string[]) ?? []).join(', ') || '—'}`; break;
    default: text = '';
  }
  return <div className="pt-ctl-usage" data-testid="pt-ctl-usage">{text}</div>;
}

function LockConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return (
    <div className="pt-ctl-lock" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
      <strong style={{ fontSize: 13 }}>Lock this control?</strong>
      <span className="pt-note" style={{ margin: 0 }}>You will be able to make this rule stricter, but you will not be able to loosen or disable it until the next trading day.</span>
      <div className="pt-actions" style={{ marginTop: 4 }}>
        <button className="pt-btn" onClick={onCancel}>Cancel</button>
        <button className="pt-btn gold" data-testid="pt-lock-confirm" onClick={onConfirm}>Lock until next trading day</button>
      </div>
    </div>
  );
}

function valueOf(c: PersonalControlView): PersonalControlValue {
  return { valueMicros: c.valueMicros ?? null, valueInt: c.valueInt ?? null, windowStart: c.windowStart ?? null, windowEnd: c.windowEnd ?? null, sessions: c.sessions ?? null };
}
