/*
 * Three distinct hero concepts for the design lab.
 *
 *   A — Chrome object: a physical chrome arrow floating in a black studio, massive
 *       wordmark, minimal copy. The signature-object direction.
 *   B — Kinetic typography: type IS the visual. Mega words with cursor parallax and
 *       an account ticker. The typography-first direction.
 *   C — Product: a floating Atlas window that leans to the cursor with live product
 *       motion inside. The product-first direction.
 */
import { useRef, type JSX } from 'react';
import { ChromeArrow } from './ChromeArrow';
import { MiniChart } from './MiniChart';
import { MagneticButton } from './widgets';
import { lerp, prefersReduced, usePointer, useRaf } from './hooks';
import { ALL_ACCOUNTS, price } from '../catalog';
import { SITE } from '../site';
import { goExternal } from '../components';

// ---- HERO A — chrome object --------------------------------------------------
export function HeroChrome(): JSX.Element {
  const host = useRef<HTMLElement | null>(null);
  const copy = useRef<HTMLDivElement | null>(null);
  const pointer = usePointer(host, true);
  const s = useRef({ x: 0, y: 0 });
  useRaf(host, () => {
    const p = pointer.current;
    s.current.x = lerp(s.current.x, p.x * 6, 0.06);
    s.current.y = lerp(s.current.y, p.y * 4, 0.06);
    if (copy.current) copy.current.style.transform = `translate(${(-s.current.x).toFixed(2)}px, ${(-s.current.y).toFixed(2)}px)`;
  });
  return (
    <section className="heroA" ref={host}>
      <div className="heroA-eyebrow">Futures Proprietary Trading</div>
      <div className="heroA-object">
        <ChromeArrow size={Math.min(440, typeof window !== 'undefined' ? window.innerWidth * 0.72 : 440)} />
      </div>
      <div className="heroA-copy" ref={copy}>
        <h1 className="ht-chrome-text">HAPPY TRADER</h1>
        <p className="sub">Trade futures on our capital. Prove your edge, get funded, keep up to 90%.</p>
        <div className="heroA-actions">
          <MagneticButton onClick={() => goExternal(SITE.routes.getStarted)}>Get funded</MagneticButton>
          <MagneticButton variant="ghost" onClick={() => goExternal(SITE.routes.signIn)}>Sign in</MagneticButton>
        </div>
      </div>
    </section>
  );
}

// ---- HERO B — kinetic typography --------------------------------------------
export function HeroType(): JSX.Element {
  const host = useRef<HTMLElement | null>(null);
  const r1 = useRef<HTMLSpanElement | null>(null);
  const r2 = useRef<HTMLSpanElement | null>(null);
  const r3 = useRef<HTMLSpanElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const pointer = usePointer(host, true);
  const s = useRef({ a: 0, b: 0, c: 0, tx: 0 });

  useRaf(host, (_t, dt) => {
    const p = pointer.current;
    // Different mass per row: the big rows move least.
    s.current.a = lerp(s.current.a, p.x * 10, 0.05);
    s.current.b = lerp(s.current.b, p.x * 22, 0.05);
    s.current.c = lerp(s.current.c, p.x * 6, 0.05);
    if (r1.current) r1.current.style.transform = `translateX(${s.current.a.toFixed(2)}px)`;
    if (r2.current) r2.current.style.transform = `translateX(${s.current.b.toFixed(2)}px)`;
    if (r3.current) r3.current.style.transform = `translateX(${s.current.c.toFixed(2)}px)`;
    // Marquee.
    s.current.tx -= dt * 0.045;
    if (track.current) {
      const half = track.current.scrollWidth / 2;
      if (half && s.current.tx <= -half) s.current.tx += half;
      track.current.style.transform = `translateX(${s.current.tx.toFixed(2)}px)`;
    }
  });

  const tickerItems = ALL_ACCOUNTS.map((a) => (
    <span key={`${a.family}-${a.size}`} className={a.gold ? 'g' : undefined}>
      {a.familyName} ${a.size} · {price(a.priceUsd)}
    </span>
  ));

  return (
    <section className="heroB" ref={host}>
      <div className="heroB-mega">
        <span className="row r1" ref={r1}>Trade</span>
        <span className="row r2 outline" ref={r2}>Futures</span>
        <span className="row r3" ref={r3}>
          <span className="ht-chrome-text">Funded.</span>
        </span>
      </div>
      <div className="heroB-foot">
        <p>Prove your edge on a simulated evaluation and keep up to 90% of the profit on our capital.</p>
        <MagneticButton onClick={() => goExternal(SITE.routes.getStarted)}>Get funded</MagneticButton>
      </div>
      <div className="heroB-ticker" aria-hidden="true">
        <div className="track" ref={track}>
          {tickerItems}
          {tickerItems}
        </div>
      </div>
    </section>
  );
}

// ---- HERO C — product window -------------------------------------------------
export function HeroAtlas(): JSX.Element {
  const host = useRef<HTMLElement | null>(null);
  const win = useRef<HTMLDivElement | null>(null);
  const order = useRef<HTMLDivElement | null>(null);
  const pointer = usePointer(host, true);
  const s = useRef({ rx: 0, ry: 0, orderT: 0, on: false });

  useRaf(host, (_t, dt) => {
    const p = pointer.current;
    s.current.ry = lerp(s.current.ry, p.x * 9, 0.07);
    s.current.rx = lerp(s.current.rx, -p.y * 7, 0.07);
    if (win.current) {
      win.current.style.transform = `rotateX(${s.current.rx.toFixed(2)}deg) rotateY(${s.current.ry.toFixed(2)}deg)`;
    }
    // Periodically flash a working order into the panel.
    s.current.orderT += dt;
    const shouldShow = Math.floor(s.current.orderT / 2600) % 2 === 1;
    if (shouldShow !== s.current.on) {
      s.current.on = shouldShow;
      if (order.current) order.current.setAttribute('data-on', shouldShow ? 'true' : 'false');
    }
  });

  const staticOrder = prefersReduced();

  return (
    <section className="heroC" ref={host}>
      <div className="heroC-copy">
        <h1>Meet <span className="ht-chrome-text">Atlas</span>.</h1>
        <p>We built our own futures platform. The account, the rules and the chart are one system — fast, clean, yours.</p>
        <div className="heroC-actions">
          <MagneticButton onClick={() => goExternal(SITE.routes.getStarted)}>Get funded</MagneticButton>
          <MagneticButton variant="ghost" onClick={() => goExternal(SITE.routes.getStarted)}>Explore accounts</MagneticButton>
        </div>
      </div>
      <div className="heroC-stage">
        <div className="lab-atlas-win" ref={win}>
          <div className="lab-atlas-top">
            <span className="lab-atlas-dot" /><span className="lab-atlas-dot" /><span className="lab-atlas-dot" />
            <span className="lab-atlas-tab">ATLAS · NQ · 1m · SIM</span>
          </div>
          <div className="lab-atlas-body">
            <div className="lab-atlas-chart"><MiniChart /></div>
            <div className="lab-atlas-side">
              <div className="lbl">Order ticket</div>
              <div className="lab-buy">Buy · Market</div>
              <div className="lab-sell">Sell · Market</div>
              <div className="lab-atlas-metric"><span className="l">Balance</span><span className="v">$100,000</span></div>
              <div className="lab-atlas-metric"><span className="l">Day P&amp;L</span><span className="v pos">+$1,240</span></div>
              <div className="lab-atlas-metric"><span className="l">Drawdown</span><span className="v">$4,000</span></div>
              <div className="lab-atlas-order" ref={order} data-on={staticOrder ? 'true' : 'false'}>
                WORKING · BUY 2 NQ @ 20,418.50 · TP 20,462 · SL 20,392
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

