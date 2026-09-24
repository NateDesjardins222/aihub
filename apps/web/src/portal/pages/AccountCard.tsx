import { useState } from 'react';
import type { JSX } from 'react';
import { type AccountSummary, AccountPath, familyOf, money, Money, Pill } from '../lib';

/** Drawdown band + fill for the MLL bar, from authoritative summary fields. */
function drawdown(a: AccountSummary): { band: string; fillPct: number; headroom: number } {
  const headroom = a.balanceMicros - a.drawdownFloorMicros;
  const distance = a.startingBalanceMicros - a.drawdownFloorMicros;
  const frac = distance > 0 ? headroom / distance : null;
  let band = 'safe';
  if (headroom <= 0) band = 'breached';
  else if (frac != null && frac < 0.1) band = 'at_risk';
  else if (frac != null && frac < 0.25) band = 'approaching';
  const fillPct = frac == null ? 100 : Math.max(0, Math.min(100, frac * 100));
  return { band, fillPct, headroom: Math.max(0, headroom) };
}

const abbrev = (publicId: string): string => `•••• ${publicId.slice(-4)}`;

export function AccountCard({
  a, onOpen, onNick, onArchive, onReset, busy,
}: {
  a: AccountSummary;
  onOpen: (id: string) => void;
  onNick?: (value: string) => void;
  onArchive?: () => void;
  onReset?: () => void;
  busy?: boolean;
}): JSX.Element {
  const [nick, setNick] = useState(a.nickname ?? '');
  const dd = drawdown(a);
  const net = a.balanceMicros - a.startingBalanceMicros;
  const family = familyOf(a.product?.key);
  const tradable = a.status === 'ACTIVE' && (a.accountType === 'EVALUATION' || a.accountType === 'FUNDED_SIM');
  const sizeLabel = a.product?.name ?? `${money(a.startingBalanceMicros)}`;

  return (
    <section className={`pt-card${family === 'GOLD' ? ' gold' : ''}`} data-testid="pt-account-card">
      <div className="pt-acct-head">
        <div>
          <div className={`pt-acct-fam${family === 'GOLD' ? ' gold' : ''}`}>{family} {a.product ? sizeLabel.replace(/CORE|SELECT|DAILY|Gold/gi, '').trim() : ''}</div>
          <h3 style={{ marginTop: 2 }}>{a.nickname || a.name}</h3>
        </div>
        <Pill state={a.portalState} />
      </div>
      <div className="muted">Account {abbrev(a.publicId)}</div>

      <div className="pt-acct-bal num">{money(a.balanceMicros)}</div>
      <div className="pt-acct-bal-k">Balance · Net <Money micros={net} sign /></div>

      <div className="pt-acct-rows">
        <div className="r"><span className="k">MLL room</span><Money micros={dd.headroom} /></div>
        <div className="r"><span className="k">Start balance</span><span className="num">{money(a.startingBalanceMicros)}</span></div>
      </div>
      <div className={`pt-bar ${dd.band}`} title={`MLL headroom ${money(dd.headroom)}`}><span style={{ width: `${dd.fillPct}%` }} /></div>

      <div style={{ marginTop: 14 }}><AccountPath portalState={a.portalState} /></div>

      {onNick && (
        <div style={{ marginTop: 12 }}>
          <input
            className="pt-nick"
            data-testid="pt-nick"
            value={nick}
            maxLength={60}
            placeholder="Add a nickname"
            onChange={(e) => setNick(e.target.value)}
            onBlur={() => onNick(nick)}
            onKeyDown={(e) => { if (e.key === 'Enter') onNick(nick); }}
          />
        </div>
      )}

      <div className="pt-actions">
        <button className="pt-btn" onClick={() => onOpen(a.id)}>View account</button>
        {tradable && <button className="pt-btn primary" onClick={() => { window.location.href = `/?account=${a.publicId}`; }}>Trade →</button>}
        {onReset && a.status === 'FAILED' && a.accountType === 'EVALUATION' && <button className="pt-btn gold" disabled={busy} onClick={onReset}>Reset</button>}
        {onArchive && !a.consumesSlot && <button className="pt-link" disabled={busy} onClick={onArchive}>{a.archivedAt ? 'Unarchive' : 'Archive'}</button>}
      </div>
    </section>
  );
}
