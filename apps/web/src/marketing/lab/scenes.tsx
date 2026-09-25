/*
 * Scroll-driven scenes for the lab: Atlas growing into the viewport, the massive
 * $0 / 90% number moments, and the payout path with a travelling chrome arrow.
 * Scroll progress is read via rAF-on-scroll and written straight to element style —
 * no per-frame React state. Under reduced motion the CSS collapses the tall
 * scroll-scrub sections to normal blocks.
 */
import { useRef, useState, type JSX } from 'react';
import { clamp, lerp, useScrollProgress } from './hooks';
import { MiniChart } from './MiniChart';
import { ChromeArrow } from './ChromeArrow';

// ---- Atlas grows into the viewport ------------------------------------------
export function AtlasGrow(): JSX.Element {
  const scene = useRef<HTMLDivElement | null>(null);
  const win = useRef<HTMLDivElement | null>(null);
  const cap = useRef<HTMLDivElement | null>(null);
  useScrollProgress(scene, (p) => {
    // Grow from small to nearly full-bleed across the middle of the scroll.
    const k = clamp((p - 0.1) / 0.7, 0, 1);
    const scale = lerp(0.46, 1.0, k);
    if (win.current) win.current.style.transform = `scale(${scale.toFixed(3)})`;
    if (cap.current) cap.current.style.opacity = String(clamp(1 - k * 1.6, 0, 1));
  });
  return (
    <div className="atlasGrow" ref={scene}>
      <div className="atlasGrow-sticky">
        <div className="atlasGrow-cap" ref={cap}>
          <h2>They built their own platform.</h2>
          <p>Scroll to step inside Atlas.</p>
        </div>
        <div className="atlasGrow-win" ref={win} style={{ width: 'min(1100px, 92vw)' }}>
          <div className="lab-atlas-win">
            <div className="lab-atlas-top">
              <span className="lab-atlas-dot" /><span className="lab-atlas-dot" /><span className="lab-atlas-dot" />
              <span className="lab-atlas-tab">ATLAS · ES · 1m · SIM</span>
            </div>
            <div className="lab-atlas-body">
              <div className="lab-atlas-chart"><MiniChart seed={19} /></div>
              <div className="lab-atlas-side">
                <div className="lbl">Order ticket</div>
                <div className="lab-buy">Buy · Market</div>
                <div className="lab-sell">Sell · Market</div>
                <div className="lab-atlas-metric"><span className="l">Balance</span><span className="v">$100,000</span></div>
                <div className="lab-atlas-metric"><span className="l">Day P&amp;L</span><span className="v pos">+$1,240</span></div>
                <div className="lab-atlas-metric"><span className="l">Contracts</span><span className="v">10 / 100</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Big number moment -------------------------------------------------------
function BigNumberScene({ value, word, gold }: { value: string; word: string; gold?: boolean }): JSX.Element {
  const scene = useRef<HTMLDivElement | null>(null);
  const num = useRef<HTMLDivElement | null>(null);
  const lbl = useRef<HTMLDivElement | null>(null);
  useScrollProgress(scene, (p) => {
    const scale = lerp(0.82, 1.06, clamp(p, 0, 1));
    if (num.current) num.current.style.transform = `scale(${scale.toFixed(3)})`;
    const k = clamp((p - 0.35) / 0.3, 0, 1);
    if (lbl.current) {
      lbl.current.style.opacity = String(k);
      lbl.current.style.transform = `translateY(${lerp(24, 0, k).toFixed(1)}px)`;
    }
  });
  return (
    <div className="bignum-scene" ref={scene}>
      <div className="bignum-sticky">
        <div className="bignum-huge" data-gold={gold ? 'true' : 'false'} ref={num}>{value}</div>
        <div className="bignum-word" ref={lbl}>{word}</div>
      </div>
    </div>
  );
}

export function BigNumbers(): JSX.Element {
  return (
    <div className="bignum">
      <BigNumberScene value="$0" word="Activation fees" />
      <BigNumberScene value="90%" word="Trader profit split" />
    </div>
  );
}

// ---- Payout path -------------------------------------------------------------
const STAGES = [
  { k: 'CHOOSE', d: 'Pick an account' },
  { k: 'PROVE', d: 'Pass the evaluation' },
  { k: 'FUNDED', d: 'Get your account' },
  { k: 'PAID', d: 'Keep up to 90%' },
];

export function PayoutPath(): JSX.Element {
  const scene = useRef<HTMLDivElement | null>(null);
  const fill = useRef<HTMLSpanElement | null>(null);
  const arrow = useRef<HTMLDivElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(-1);

  useScrollProgress(scene, (p) => {
    // Map the middle of the scroll to 0..1 across the track.
    const k = clamp((p - 0.2) / 0.55, 0, 1);
    if (fill.current) fill.current.style.width = `${(k * 100).toFixed(1)}%`;
    if (arrow.current && track.current) {
      const w = track.current.clientWidth;
      arrow.current.style.transform = `translateX(${(k * (w - 40)).toFixed(1)}px) rotate(90deg)`;
    }
    const idx = k >= 0.98 ? 3 : k >= 0.66 ? 2 : k >= 0.4 ? 1 : k >= 0.12 ? 0 : -1;
    setActive((prev) => (prev === idx ? prev : idx));
  });

  return (
    <div className="payPath" ref={scene}>
      <div className="payPath-inner">
        <div className="payPath-head">
          <div className="ht-eyebrow" style={{ justifyContent: 'center', display: 'inline-flex' }}>The path to paid</div>
          <h2 style={{ marginTop: 16 }}>Choose. Prove. Funded. Paid.</h2>
        </div>
        <div className="payPath-track" ref={track}>
          <div className="payPath-line"><span className="fill" ref={fill} /></div>
          <div ref={arrow} style={{ position: 'absolute', top: 4, left: 0, width: 40, height: 40, zIndex: 5, pointerEvents: 'none' }}>
            <ChromeArrow size={40} idle={false} />
          </div>
          {STAGES.map((s, i) => (
            <div key={s.k} className="payStage" data-on={i <= active ? 'true' : 'false'} data-paid={s.k === 'PAID' && active >= 3 ? 'true' : 'false'}>
              <div className="node">{i < 3 ? String(i + 1) : '★'}</div>
              <h3>{s.k}</h3>
              <p>{s.d}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
