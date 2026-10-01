/**
 * HAPPY TRADER — Celebration engine (Experience Layer Phase 2).
 *
 * ONE reusable celebration system (§22). A premium, luxury-product moment — never
 * childish confetti, never a casino. It is driven ENTIRELY by authoritative server
 * events (`GET /api/v1/portal/celebrations`), shown at most once per event, and
 * acknowledged server-side on dismiss (`POST .../celebrations/ack`) so it never
 * replays on refresh (§23). Multiple unseen moments are prioritised and shown one at
 * a time with a compact "you also earned" summary (§75/§76). Fully skippable,
 * non-blocking after dismissal, and reduced-motion aware.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api } from '../../api/client';
import { formatMoney } from './format';
import { usePrefersReducedMotion } from './experience';
import { V2Button } from './primitives';

export type CelebrationKind = 'FUNDED' | 'PAYOUT' | 'CLUB' | 'ACCOUNT_COMPLETED' | 'MILESTONE';
export type CelebrationIntensity = 'HIGH' | 'MAJOR' | 'MEDIUM';
export interface CelebrationEvent {
  eventKey: string;
  type: string;
  kind: CelebrationKind;
  intensity: CelebrationIntensity;
  priority: number;
  occurredAt: number;
  amountMicros: number | null;
  accountId: string | null;
  accountPublicId: string | null;
  accountName: string | null;
  certificateId: string | null;
}

export interface CelebrationActions {
  onOpenAccount?: (accountId: string) => void;
  onOpenCertificates?: () => void;
}

interface Copy { kicker: string; title: string; sub: string }
const CLUB_LABEL: Record<string, string> = { TENK_CLUB: '$10K Club', FIFTYK_CLUB: '$50K Club', HUNDREDK_CLUB: '$100K Club' };

function money(micros: number | null): string {
  return micros != null ? formatMoney(micros, { maxFractionDigits: 0 }) : '';
}

function copyFor(e: CelebrationEvent): Copy {
  const acct = e.accountName ?? 'your account';
  switch (e.type) {
    case 'FUNDED':
      return { kicker: 'Congratulations', title: "You're a Happy Funded Trader", sub: `${acct} is ready. Your funded account is live.` };
    case 'FIRST_PAYOUT':
      return { kicker: 'Your first payout', title: money(e.amountMicros) || 'Paid to you', sub: e.accountName ? `Paid to you · ${e.accountName}` : 'Paid to you.' };
    case 'PAID_5K': case 'PAID_10K': case 'PAID_25K':
      return { kicker: 'Payout milestone', title: `${money(e.amountMicros)} paid to you`, sub: 'A lifetime payout milestone, reached.' };
    case 'FIVE_PAYOUT_CLUB':
      return { kicker: 'Five-payout club', title: 'Five payouts, paid', sub: 'Consistency, rewarded.' };
    case 'ACCOUNT_COMPLETED':
      return { kicker: 'Account completed', title: 'You completed a funded account', sub: `${acct} reached its full payout journey.` };
    case 'TENK_CLUB': case 'FIFTYK_CLUB': case 'HUNDREDK_CLUB':
      return { kicker: `${CLUB_LABEL[e.type]}`, title: `Welcome to the ${CLUB_LABEL[e.type]}`, sub: 'A lifetime-payouts milestone.' };
    default:
      return { kicker: 'Milestone', title: 'A new milestone', sub: '' };
  }
}

/** Particle counts by intensity (kept lightweight; Canvas 2D, single RAF). */
const PARTICLES: Record<CelebrationIntensity, number> = { HIGH: 150, MAJOR: 100, MEDIUM: 56 };
const ROSE = ['#e6c7bd', '#e7dcc4', '#d8b2a4', '#f3ecd9', '#cfc7bd'];

/** A self-disposing rose-gold burst. Stops on unmount; never leaks RAF/listeners. */
function CelebrationCanvas({ intensity }: { intensity: CelebrationIntensity }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = (): void => { canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; };
    resize();
    const W = () => canvas.width, H = () => canvas.height;
    const n = PARTICLES[intensity];
    interface P { x: number; y: number; vx: number; vy: number; g: number; life: number; max: number; size: number; c: string; rot: number; vr: number }
    const cx = W() / 2, cy = H() * 0.42;
    const parts: P[] = Array.from({ length: n }).map(() => {
      const ang = Math.random() * Math.PI * 2;
      const speed = (3 + Math.random() * 7) * dpr;
      const max = 90 + Math.random() * 70;
      return { x: cx, y: cy, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed - 3 * dpr, g: 0.12 * dpr, life: 0, max, size: (2 + Math.random() * 3) * dpr, c: ROSE[Math.floor(Math.random() * ROSE.length)]!, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3 };
    });
    let raf = 0; let stopped = false;
    const frame = (): void => {
      if (stopped) return;
      ctx.clearRect(0, 0, W(), H());
      let alive = false;
      for (const p of parts) {
        if (p.life >= p.max) continue;
        alive = true;
        p.life += 1; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.rot += p.vr;
        const a = 1 - p.life / p.max;
        ctx.save(); ctx.globalAlpha = Math.max(0, a); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.c; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.6);
        ctx.restore();
      }
      if (alive) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
    return () => { stopped = true; cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [intensity]);
  return <canvas ref={ref} className="htv2-celebrate-canvas" aria-hidden />;
}

/** The celebration modal for a single authoritative moment. */
export function V2Celebration({ event, remaining, onDismiss, actions }: {
  event: CelebrationEvent; remaining: number; onDismiss: () => void; actions: CelebrationActions;
}): JSX.Element {
  const reduced = usePrefersReducedMotion();
  const c = copyFor(event);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div className="htv2 htv2-celebrate-scrim" role="dialog" aria-modal="true" aria-label={c.title} data-testid="htv2-celebration" data-event-kind={event.kind}>
      {!reduced && <CelebrationCanvas intensity={event.intensity} />}
      <div className="htv2-celebrate-card">
        <button className="htv2-celebrate-x" onClick={onDismiss} aria-label="Dismiss">✕</button>
        <div className="htv2-celebrate-emblem htv2-aura htv2-aura-rose htv2-aura-on" aria-hidden>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--ht-rose)" strokeWidth="1.5"><path d="M4 14c3 4 13 4 16 0" strokeLinecap="round" /><path d="M14 9l6-2-2 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <div className="htv2-celebrate-kicker ht-t-label">{c.kicker}</div>
        <h2 className="htv2-celebrate-title ht-t-display htv2-metal-rose">{c.title}</h2>
        {c.sub && <p className="htv2-celebrate-sub ht-t-body-sm">{c.sub}</p>}
        <div className="htv2-celebrate-actions">
          {event.accountId && actions.onOpenAccount && (
            <V2Button variant="primary" size="sm" testId="htv2-celebration-account" onClick={() => { actions.onOpenAccount?.(event.accountId!); onDismiss(); }}>
              {event.kind === 'FUNDED' ? 'View funded account' : 'View account'}
            </V2Button>
          )}
          {event.certificateId && actions.onOpenCertificates && (
            <V2Button variant="secondary" size="sm" testId="htv2-celebration-cert" onClick={() => { actions.onOpenCertificates?.(); onDismiss(); }}>View certificate</V2Button>
          )}
          <V2Button variant={event.accountId || event.certificateId ? 'tertiary' : 'primary'} size="sm" testId="htv2-celebration-dismiss" onClick={onDismiss}>
            {remaining > 0 ? 'Continue' : 'Done'}
          </V2Button>
        </div>
        {remaining > 0 && <div className="htv2-celebrate-also ht-t-meta">You also earned {remaining} more {remaining === 1 ? 'milestone' : 'milestones'} — we’ll show {remaining === 1 ? 'it' : 'them'} next.</div>}
      </div>
    </div>
  );
}

/**
 * The celebration controller. Fetches the authoritative pending feed once on mount,
 * shows the highest-priority moment, acks it on dismiss, then advances. Never shows
 * an acked moment again. Returns the element to render (or null).
 */
export function CelebrationHost({ actions }: { actions: CelebrationActions }): JSX.Element | null {
  const [queue, setQueue] = useState<CelebrationEvent[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    let live = true;
    void api.get<{ pending: CelebrationEvent[] }>('/api/v1/portal/celebrations')
      .then((r) => { if (live && Array.isArray(r.pending)) setQueue(r.pending); })
      .catch(() => { /* celebrations are non-essential; a failure is silent */ });
    return () => { live = false; };
  }, []);

  const current = queue[0] ?? null;
  const dismiss = useCallback(() => {
    const ev = queue[0];
    if (!ev) return;
    // Ack server-side so it never replays; advance locally regardless of ack result.
    void api.post('/api/v1/portal/celebrations/ack', { eventKey: ev.eventKey }).catch(() => {});
    setQueue((q) => q.slice(1));
  }, [queue]);

  if (!current) return null;
  return <V2Celebration event={current} remaining={queue.length - 1} onDismiss={dismiss} actions={actions} />;
}
