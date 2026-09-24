/*
 * Happy Trader customer portal — the trader-facing home beside Atlas.
 *
 * Dashboard, accounts, deep per-account analytics, certificates, achievements
 * and profile. Every figure is read from the server (owner-scoped /api/v1/portal
 * routes); the browser never computes a balance or a status. Presentation-only
 * nicknames and the achievements visibility toggle are the only mutations here.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { api, ApiRequestError } from '../api/client';
import { useSession } from '../state/session';
import './Portal.css';

// ---- Types (mirror the portal API projections) ----------------------------
interface AccountSummary {
  id: string;
  publicId: string;
  name: string;
  nickname: string | null;
  accountType: string;
  status: string;
  portalState: string;
  consumesSlot: boolean;
  product: { key: string; name: string; version: number } | null;
  startingBalanceMicros: number;
  balanceMicros: number;
  highWaterMarkMicros: number;
  drawdownFloorMicros: number;
  resetOfAccountId: string | null;
  archivedAt: number | null;
  createdAt: number;
}
interface AccountsView { accounts: AccountSummary[]; activeSlotsUsed: number; maxActiveSlots: number }
interface Analytics {
  accountId: string;
  currentBalanceMicros: number;
  startingBalanceMicros: number;
  currentDrawdownMicros: number;
  mllHeadroomMicros: number;
  trades: {
    totalTrades: number; winningTrades: number; losingTrades: number; breakevenTrades: number;
    winRate: number | null; profitFactor: number | null; netPnlMicros: number; expectancyMicros: number;
    averageWinMicros: number; averageLossMicros: number; largestWinMicros: number; largestLossMicros: number;
    averageRMultiple: number | null; rSampleSize: number;
  };
  streaks: { currentStreak: number; bestWinStreak: number; worstLossStreak: number };
  days: { totalTradingDays: number; profitableDays: number; percentProfitableDays: number | null; bestDayMicros: number; worstDayMicros: number };
  equity: { points: Array<{ tExitMs: number; equityMicros: number; drawdownMicros: number }>; maxDrawdownMicros: number; finalEquityMicros: number };
  breakdowns: { byInstrument: Breakdown[]; bySide: Breakdown[] };
}
interface Breakdown { key: string; trades: number; netPnlMicros: number; winRate: number | null }
interface Cert { id: string; certificatePublicId: string; verificationToken: string; type: string; publicDisplayName: string; amountMicros: number | null; status: string; issuedAt: number }
interface Achievement { id: string; type: string; isPublic: boolean; meta: Record<string, unknown> | null; earnedAt: number }
interface AchievementsView { achievementsPublic: boolean; achievements: Achievement[] }

type View = 'dashboard' | 'accounts' | 'detail' | 'certificates' | 'achievements' | 'profile';

const M = 1_000_000;
function money(micros: number | null | undefined): string {
  if (micros == null) return '—';
  const v = micros / M;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
function pct(x: number | null): string { return x == null ? '—' : `${(x * 100).toFixed(1)}%`; }
function stateLabel(s: string): string {
  return ({
    EVALUATION_ACTIVE: 'Evaluation', FUNDED_ACTIVE: 'Funded', EVALUATION_PASSED: 'Passed',
    FAILED: 'Breached', COMPLETED_MAX_PAYOUTS: 'Completed', INACTIVE_CLOSED: 'Closed',
    ARCHIVED: 'Archived', PENDING: 'Pending',
  } as Record<string, string>)[s] ?? s;
}
function badgeClass(s: string): string {
  return ({
    EVALUATION_ACTIVE: 'eval', FUNDED_ACTIVE: 'funded', EVALUATION_PASSED: 'passed',
    FAILED: 'failed', COMPLETED_MAX_PAYOUTS: 'completed', INACTIVE_CLOSED: 'inactive',
    ARCHIVED: 'archived', PENDING: 'pending',
  } as Record<string, string>)[s] ?? 'eval';
}
function achLabel(t: string): string {
  return ({
    FUNDED: 'Funded Trader', FIRST_PAYOUT: 'First Payout', PAID_5K: '$5K Paid', PAID_10K: '$10K Paid',
    PAID_25K: '$25K Paid', FIVE_PAYOUT_CLUB: 'Five-Payout Club', ACCOUNT_COMPLETED: 'Account Completed',
  } as Record<string, string>)[t] ?? t;
}
function certLabel(t: string): string {
  return ({ EVALUATION_PASSED: 'Evaluation Passed', FUNDED_TRADER: 'Funded Trader', PAYOUT: 'Payout', ACCOUNT_COMPLETED: 'Account Completed' } as Record<string, string>)[t] ?? t;
}

export function PortalApp(): JSX.Element {
  const signOut = useSession((s) => s.signOut);
  const [view, setView] = useState<View>('dashboard');
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(null), 2400); }, []);
  const openDetail = useCallback((id: string) => { setSelected(id); setView('detail'); }, []);

  const nav: Array<[View, string]> = [
    ['dashboard', 'Dashboard'], ['accounts', 'Accounts'], ['certificates', 'Certificates'],
    ['achievements', 'Achievements'], ['profile', 'Profile'],
  ];

  return (
    <div className="pt" data-testid="portal-app">
      <header className="pt-top">
        <div className="pt-mark" aria-hidden />
        <div className="pt-brand">Happy Trader <span className="g">Portal</span></div>
        <nav className="pt-nav">
          {nav.map(([v, label]) => (
            <button key={v} data-testid={`pt-nav-${v}`} className={view === v || (v === 'accounts' && view === 'detail') ? 'on' : ''} onClick={() => { setView(v); }}>
              {label}
            </button>
          ))}
        </nav>
        <div className="pt-spacer" />
        <button className="pt-ghost" onClick={() => { window.location.href = '/onboarding'; }}>Buy an account</button>
        <button className="pt-ghost" onClick={() => { void signOut(); }}>Sign out</button>
      </header>

      <main className="pt-main">
        {view === 'dashboard' && <Dashboard onOpen={openDetail} onNav={setView} />}
        {view === 'accounts' && <Accounts onOpen={openDetail} onToast={showToast} />}
        {view === 'detail' && selected && <AccountDetail accountId={selected} onBack={() => setView('accounts')} />}
        {view === 'certificates' && <Certificates onToast={showToast} />}
        {view === 'achievements' && <Achievements onToast={showToast} />}
        {view === 'profile' && <Profile onToast={showToast} />}
      </main>

      {toast && <div className="pt-toast" role="status">{toast}</div>}
    </div>
  );
}

// ---- Dashboard ------------------------------------------------------------
function Dashboard({ onOpen, onNav }: { onOpen: (id: string) => void; onNav: (v: View) => void }): JSX.Element {
  const [view, setView] = useState<AccountsView | null>(null);
  const [certs, setCerts] = useState<Cert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api.get<AccountsView>('/api/v1/portal/accounts').then(setView).catch((e: unknown) => setErr(msg(e)));
    void api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates').then((r) => setCerts(r.certificates)).catch(() => setCerts([]));
  }, []);
  if (err) return <p className="pt-error">{err}</p>;
  if (!view) return <p className="pt-empty">Loading…</p>;
  const active = view.accounts.filter((a) => a.consumesSlot);
  return (
    <>
      <h1 className="pt-h1">Your trading</h1>
      <p className="pt-sub">Accounts, performance and recognition — all read from your authoritative records.</p>
      <div className="pt-card" style={{ marginBottom: 18 }}>
        <div className="pt-row">
          <div>
            <div className="muted">Active accounts</div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 2 }}>{view.activeSlotsUsed} <span style={{ color: 'var(--pt-dim)', fontSize: 16 }}>/ {view.maxActiveSlots}</span></div>
          </div>
          <div className="pt-slot-meter">
            <div className="pt-pips">
              {Array.from({ length: view.maxActiveSlots }, (_, i) => <div key={i} className={`pt-pip${i < view.activeSlotsUsed ? ' on' : ''}`} />)}
            </div>
          </div>
        </div>
        <p className="pt-note">A trader may hold at most {view.maxActiveSlots} active accounts at once. Passing, breaching or completing an account frees a slot.</p>
      </div>
      <div className="pt-section-title">Active accounts</div>
      {active.length === 0 ? (
        <div className="pt-empty">No active accounts. <button className="pt-link" onClick={() => { window.location.href = '/onboarding'; }}>Get funded</button></div>
      ) : (
        <div className="pt-cards">{active.map((a) => <MiniAccount key={a.id} a={a} onOpen={onOpen} />)}</div>
      )}
      <div className="pt-section-title">Recent certificates</div>
      {certs && certs.length > 0 ? (
        <div className="pt-cards">
          {certs.slice(0, 3).map((c) => (
            <div className="pt-card" key={c.id}>
              <span className={`pt-badge ${badgeClass('FUNDED_ACTIVE')}`}><span className="dot" />{certLabel(c.type)}</span>
              <div className="id" style={{ marginTop: 10 }}>{c.certificatePublicId}</div>
              <div className="muted">{c.publicDisplayName}</div>
            </div>
          ))}
        </div>
      ) : <p className="pt-note">Certificates you earn — passing an evaluation, getting funded, each payout — appear here. <button className="pt-link" onClick={() => onNav('certificates')}>View all</button></p>}
    </>
  );
}

function MiniAccount({ a, onOpen }: { a: AccountSummary; onOpen: (id: string) => void }): JSX.Element {
  const dd = drawdown(a);
  return (
    <div className="pt-card">
      <div className="pt-row">
        <h3>{a.nickname || a.name}</h3>
        <span className={`pt-badge ${badgeClass(a.portalState)}`}><span className="dot" />{stateLabel(a.portalState)}</span>
      </div>
      <div className="muted">#{a.publicId}</div>
      <div className="pt-metrics" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="pt-metric"><div className="k">Balance</div><div className="v">{money(a.balanceMicros)}</div></div>
        <div className="pt-metric"><div className="k">MLL headroom</div><div className={`v ${dd.band === 'BREACHED' ? 'neg' : ''}`}>{money(Math.max(0, a.balanceMicros - a.drawdownFloorMicros))}</div></div>
      </div>
      <div className={`pt-bar ${dd.band.toLowerCase()}`}><span style={{ width: `${dd.fillPct}%` }} /></div>
      <div className="pt-actions">
        <button className="pt-btn" onClick={() => onOpen(a.id)}>Analytics</button>
        {a.status === 'ACTIVE' && <button className="pt-link" onClick={() => { window.location.href = `/?account=${a.publicId}`; }}>Open in terminal</button>}
      </div>
    </div>
  );
}

// ---- Accounts -------------------------------------------------------------
function Accounts({ onOpen, onToast }: { onOpen: (id: string) => void; onToast: (m: string) => void }): JSX.Element {
  const [view, setView] = useState<AccountsView | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    void api.get<AccountsView>(`/api/v1/portal/accounts?includeArchived=${includeArchived}`).then(setView).catch((e: unknown) => setErr(msg(e)));
  }, [includeArchived]);
  useEffect(load, [load]);
  if (err) return <p className="pt-error">{err}</p>;
  if (!view) return <p className="pt-empty">Loading…</p>;
  return (
    <>
      <h1 className="pt-h1">Accounts</h1>
      <p className="pt-sub">{view.activeSlotsUsed} of {view.maxActiveSlots} active slots used.</p>
      <label className="pt-toggle" onClick={() => setIncludeArchived((v) => !v)} style={{ marginBottom: 16 }}>
        <span className={`pt-switch`} /><span style={{ fontSize: 13, color: 'var(--pt-dim)' }}>Show archived</span>
      </label>
      {view.accounts.length === 0 ? <div className="pt-empty">No accounts yet.</div> : (
        <div className="pt-cards">
          {view.accounts.map((a) => <AccountCard key={a.id} a={a} onOpen={onOpen} onToast={onToast} reload={load} />)}
        </div>
      )}
    </>
  );
}

function AccountCard({ a, onOpen, onToast, reload }: { a: AccountSummary; onOpen: (id: string) => void; onToast: (m: string) => void; reload: () => void }): JSX.Element {
  const [nick, setNick] = useState(a.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const dd = drawdown(a);
  const saveNick = async (): Promise<void> => {
    try { await api.patch(`/api/v1/portal/accounts/${a.id}/nickname`, { nickname: nick }); onToast('Nickname saved'); }
    catch (e) { onToast(msg(e)); }
  };
  const archive = async (): Promise<void> => {
    setBusy(true);
    try { await api.post(`/api/v1/portal/accounts/${a.id}/${a.archivedAt ? 'unarchive' : 'archive'}`); reload(); }
    catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  };
  const reset = async (): Promise<void> => {
    setBusy(true);
    try {
      const q = await api.get<{ priceMicros: number }>(`/api/v1/portal/accounts/${a.id}/reset-quote`);
      const r = await api.post<{ orderId: string }>(`/api/v1/portal/accounts/${a.id}/reset`, {});
      onToast(`Reset order created (${money(q.priceMicros)}). Redirecting to checkout…`);
      window.setTimeout(() => { window.location.href = `/checkout?order=${r.orderId}`; }, 900);
    } catch (e) { onToast(msg(e)); } finally { setBusy(false); }
  };
  const terminal = a.status === 'ACTIVE' && (a.accountType === 'EVALUATION' || a.accountType === 'FUNDED_SIM');
  return (
    <div className="pt-card" data-testid="pt-account-card">
      <div className="pt-row">
        <h3>{a.nickname || a.name}</h3>
        <span className={`pt-badge ${badgeClass(a.portalState)}`}><span className="dot" />{stateLabel(a.portalState)}</span>
      </div>
      <div className="muted">#{a.publicId}{a.product ? ` · ${a.product.name}` : ''}{a.resetOfAccountId ? ' · reset' : ''}</div>
      <div className="pt-metrics" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="pt-metric"><div className="k">Balance</div><div className="v">{money(a.balanceMicros)}</div></div>
        <div className="pt-metric"><div className="k">Start</div><div className="v">{money(a.startingBalanceMicros)}</div></div>
      </div>
      <div className={`pt-bar ${dd.band.toLowerCase()}`} title={`MLL headroom ${money(Math.max(0, a.balanceMicros - a.drawdownFloorMicros))}`}><span style={{ width: `${dd.fillPct}%` }} /></div>
      <div style={{ marginTop: 12 }}>
        <input className="pt-nick" value={nick} maxLength={60} placeholder="Add a nickname"
          onChange={(e) => setNick(e.target.value)} onBlur={saveNick}
          onKeyDown={(e) => { if (e.key === 'Enter') void saveNick(); }} />
      </div>
      <div className="pt-actions">
        <button className="pt-btn" onClick={() => onOpen(a.id)}>Analytics</button>
        {terminal && <button className="pt-link" onClick={() => { window.location.href = `/?account=${a.publicId}`; }}>Open in terminal</button>}
        {a.status === 'FAILED' && a.accountType === 'EVALUATION' && <button className="pt-btn gold" disabled={busy} onClick={reset}>Reset</button>}
        {!a.consumesSlot && <button className="pt-link" disabled={busy} onClick={archive}>{a.archivedAt ? 'Unarchive' : 'Archive'}</button>}
      </div>
    </div>
  );
}

// ---- Account detail + analytics -------------------------------------------
function AccountDetail({ accountId, onBack }: { accountId: string; onBack: () => void }): JSX.Element {
  const [detail, setDetail] = useState<AccountSummary & { lifecycles?: Array<{ seq: number; startedAt: number; endedAt: number | null; endReason: string | null; finalStatus: string | null; startingBalanceMicros: number }>; priceMicros?: number | null } | null>(null);
  const [an, setAn] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api.get<typeof detail>(`/api/v1/portal/accounts/${accountId}`).then(setDetail).catch((e: unknown) => setErr(msg(e)));
    void api.get<Analytics>(`/api/v1/portal/accounts/${accountId}/analytics`).then(setAn).catch((e: unknown) => setErr(msg(e)));
  }, [accountId]);
  if (err) return (<><button className="pt-back" onClick={onBack}>← Accounts</button><p className="pt-error">{err}</p></>);
  if (!detail || !an) return (<><button className="pt-back" onClick={onBack}>← Accounts</button><p className="pt-empty">Loading…</p></>);
  const t = an.trades;
  const netClass = t.netPnlMicros > 0 ? 'pos' : t.netPnlMicros < 0 ? 'neg' : '';
  return (
    <>
      <button className="pt-back" onClick={onBack}>← Accounts</button>
      <div className="pt-row">
        <h1 className="pt-h1">{detail.nickname || detail.name}</h1>
        <span className={`pt-badge ${badgeClass(detail.portalState)}`}><span className="dot" />{stateLabel(detail.portalState)}</span>
      </div>
      <p className="pt-sub">#{detail.publicId}{detail.product ? ` · ${detail.product.name}` : ''}</p>

      <div className="pt-metrics" data-testid="pt-analytics-metrics">
        <Metric k="Net P&L" v={money(t.netPnlMicros)} cls={netClass} />
        <Metric k="Win rate" v={pct(t.winRate)} />
        <Metric k="Profit factor" v={t.profitFactor == null ? '—' : t.profitFactor.toFixed(2)} />
        <Metric k="Expectancy" v={money(t.expectancyMicros)} />
        <Metric k="Trades" v={String(t.totalTrades)} />
        <Metric k="Avg R" v={t.averageRMultiple == null ? 'n/a' : `${t.averageRMultiple.toFixed(2)}R`} cls={t.averageRMultiple == null ? 'na' : ''} />
      </div>

      <div className="pt-section-title">Trading equity curve</div>
      <div className="pt-card"><EquityCurve points={an.equity.points} /><p className="pt-note">Cumulative net P&L over closed trades. Payout debits and resets are not trades and never appear here.</p></div>

      <div className="pt-section-title">Risk</div>
      <div className="pt-metrics">
        <Metric k="Balance" v={money(an.currentBalanceMicros)} />
        <Metric k="MLL headroom" v={money(an.mllHeadroomMicros)} cls={an.mllHeadroomMicros <= 0 ? 'neg' : ''} />
        <Metric k="Current drawdown" v={money(an.currentDrawdownMicros)} />
        <Metric k="Max drawdown" v={money(an.equity.maxDrawdownMicros)} />
        <Metric k="Best streak" v={`${an.streaks.bestWinStreak}`} cls="pos" />
        <Metric k="Worst streak" v={`${an.streaks.worstLossStreak}`} cls="neg" />
      </div>

      {an.breakdowns.byInstrument.length > 0 && (
        <>
          <div className="pt-section-title">By instrument</div>
          <div className="pt-card"><BreakdownTable rows={an.breakdowns.byInstrument} /></div>
        </>
      )}

      {detail.lifecycles && detail.lifecycles.length > 0 && (
        <>
          <div className="pt-section-title">Account history</div>
          <div className="pt-card">
            <table className="pt-table">
              <thead><tr><th>#</th><th>Started</th><th>Ended</th><th>Outcome</th><th>Start balance</th></tr></thead>
              <tbody>
                {detail.lifecycles.map((l) => (
                  <tr key={l.seq}>
                    <td>{l.seq}</td>
                    <td>{new Date(l.startedAt).toLocaleDateString()}</td>
                    <td>{l.endedAt ? new Date(l.endedAt).toLocaleDateString() : '—'}</td>
                    <td>{l.finalStatus ?? l.endReason ?? 'Active'}</td>
                    <td>{money(l.startingBalanceMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Metric({ k, v, cls }: { k: string; v: string; cls?: string }): JSX.Element {
  return <div className="pt-metric"><div className="k">{k}</div><div className={`v ${cls ?? ''}`}>{v}</div></div>;
}

function BreakdownTable({ rows }: { rows: Breakdown[] }): JSX.Element {
  return (
    <table className="pt-table">
      <thead><tr><th>Instrument</th><th>Trades</th><th>Net P&L</th><th>Win rate</th></tr></thead>
      <tbody>{rows.map((r) => (<tr key={r.key}><td>{r.key}</td><td>{r.trades}</td><td>{money(r.netPnlMicros)}</td><td>{pct(r.winRate)}</td></tr>))}</tbody>
    </table>
  );
}

function EquityCurve({ points }: { points: Array<{ equityMicros: number }> }): JSX.Element {
  if (points.length < 2) return <p className="pt-note">Not enough closed trades yet to draw a curve.</p>;
  const W = 600, H = 160, pad = 6;
  const ys = points.map((p) => p.equityMicros);
  const min = Math.min(...ys), max = Math.max(...ys);
  const range = max - min || 1;
  const x = (i: number): number => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v: number): number => H - pad - ((v - min) / range) * (H - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equityMicros).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
  const zeroY = min <= 0 && max >= 0 ? y(0) : null;
  return (
    <svg className="pt-equity" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Trading equity curve">
      <defs><linearGradient id="ptgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c8a24a" /><stop offset="100%" stopColor="#c8a24a" stopOpacity="0" /></linearGradient></defs>
      {zeroY != null && <path className="zero" d={`M0,${zeroY.toFixed(1)} L${W},${zeroY.toFixed(1)}`} />}
      <path className="area" d={area} />
      <path className="line" d={line} />
    </svg>
  );
}

// ---- Certificates ---------------------------------------------------------
function Certificates({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [certs, setCerts] = useState<Cert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api.get<{ certificates: Cert[] }>('/api/v1/portal/certificates').then((r) => setCerts(r.certificates)).catch((e: unknown) => setErr(msg(e))); }, []);
  if (err) return <p className="pt-error">{err}</p>;
  if (!certs) return <p className="pt-empty">Loading…</p>;
  const copy = (token: string): void => {
    const url = `${window.location.origin}/verify/${token}`;
    void navigator.clipboard?.writeText(url).then(() => onToast('Verification link copied')).catch(() => onToast(url));
  };
  return (
    <>
      <h1 className="pt-h1">Certificates</h1>
      <p className="pt-sub">Publicly verifiable, privacy-safe recognition. Share a link; it never exposes your legal identity.</p>
      {certs.length === 0 ? <div className="pt-empty">No certificates yet.</div> : (
        <div className="pt-cards">
          {certs.map((c) => (
            <div className="pt-card pt-cert" key={c.id}>
              <div className="pt-row">
                <span className={`pt-badge ${c.status === 'REVOKED' ? 'failed' : 'funded'}`}><span className="dot" />{certLabel(c.type)}</span>
                {c.amountMicros != null && <strong>{money(c.amountMicros)}</strong>}
              </div>
              <div className="id">{c.certificatePublicId}</div>
              <div className="muted">{c.publicDisplayName} · {new Date(c.issuedAt).toLocaleDateString()}</div>
              <div className="pt-actions">
                <button className="pt-link" onClick={() => copy(c.verificationToken)}>Copy verify link</button>
                <button className="pt-link" onClick={() => window.open(`/verify/${c.verificationToken}`, '_blank')}>View</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- Achievements ---------------------------------------------------------
function Achievements({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [view, setView] = useState<AchievementsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => { void api.get<AchievementsView>('/api/v1/portal/achievements').then(setView).catch((e: unknown) => setErr(msg(e))); }, []);
  useEffect(load, [load]);
  if (err) return <p className="pt-error">{err}</p>;
  if (!view) return <p className="pt-empty">Loading…</p>;
  const toggleAll = async (): Promise<void> => {
    try { await api.patch('/api/v1/portal/achievements/visibility', { isPublic: !view.achievementsPublic }); load(); onToast('Visibility updated'); }
    catch (e) { onToast(msg(e)); }
  };
  return (
    <>
      <h1 className="pt-h1">Achievements</h1>
      <p className="pt-sub">Milestones you have earned. Restrained by design — no points, no economy.</p>
      <label className={`pt-toggle${view.achievementsPublic ? ' on' : ''}`} onClick={toggleAll} style={{ marginBottom: 18 }}>
        <span className="pt-switch" /><span style={{ fontSize: 13 }}>Show my achievements publicly</span>
      </label>
      {view.achievements.length === 0 ? <div className="pt-empty">No achievements yet. Get funded to earn your first.</div> : (
        <div className="pt-ach-grid">
          {view.achievements.map((a) => (
            <div className="pt-ach" key={a.id}>
              <div className="emblem">{achLabel(a.type).slice(0, 1)}</div>
              <div className="t">{achLabel(a.type)}</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{new Date(a.earnedAt).toLocaleDateString()}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- Profile --------------------------------------------------------------
function Profile({ onToast }: { onToast: (m: string) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void api.get<{ preferredDisplayName: string | null; displayName: string | null }>('/api/v1/portal/profile')
      .then((r) => { setName(r.preferredDisplayName ?? ''); setDisplayName(r.displayName ?? ''); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);
  const save = async (): Promise<void> => {
    try { await api.patch('/api/v1/portal/profile', { preferredDisplayName: name }); onToast('Profile saved'); }
    catch (e) { onToast(msg(e)); }
  };
  if (!loaded) return <p className="pt-empty">Loading…</p>;
  return (
    <>
      <h1 className="pt-h1">Profile</h1>
      <p className="pt-sub">Your public display identity is separate from your legal identity, which is never shown on a certificate.</p>
      <div className="pt-card" style={{ maxWidth: 460 }}>
        <label className="k" style={{ fontSize: 12, color: 'var(--pt-dim)' }}>Public display name</label>
        <input className="pt-nick" style={{ marginTop: 8 }} value={name} maxLength={80} placeholder={displayName ? `${firstLastInitial(displayName)} (default)` : 'e.g. Nathan D.'} onChange={(e) => setName(e.target.value)} />
        <p className="pt-note">Shown on certificates and public verification. Never your email, phone or full legal name.</p>
        <div className="pt-actions"><button className="pt-btn" onClick={save}>Save</button></div>
      </div>
      <div className="pt-section-title">Verification &amp; security</div>
      <div className="pt-card" style={{ maxWidth: 460 }}>
        <p className="muted" style={{ marginTop: 0 }}>Manage contact verification, identity and agreements in onboarding.</p>
        <div className="pt-actions"><button className="pt-link" onClick={() => { window.location.href = '/onboarding'; }}>Open verification</button></div>
      </div>
    </>
  );
}

function firstLastInitial(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

// ---- helpers --------------------------------------------------------------
function drawdown(a: AccountSummary): { band: string; fillPct: number } {
  const headroom = a.balanceMicros - a.drawdownFloorMicros;
  const distance = a.startingBalanceMicros - a.drawdownFloorMicros;
  const frac = distance > 0 ? headroom / distance : null;
  let band = 'safe';
  if (headroom <= 0) band = 'breached';
  else if (frac == null) band = 'safe';
  else if (frac < 0.1) band = 'at_risk';
  else if (frac < 0.25) band = 'approaching';
  const fillPct = frac == null ? 100 : Math.max(0, Math.min(100, frac * 100));
  return { band: band.toUpperCase(), fillPct };
}

function msg(e: unknown): string {
  if (e instanceof ApiRequestError) return e.message;
  return e instanceof Error ? e.message : 'Something went wrong.';
}
