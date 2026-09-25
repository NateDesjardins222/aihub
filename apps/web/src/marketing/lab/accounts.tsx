/*
 * Two account-selector experiments.
 *
 *   A — Oversized CORE/SELECT/DAILY word switcher over a cursor-reactive particle
 *       field, with a car-configurator size selector and a spec sheet whose numbers
 *       roll when you change size. Warms to gold on the 300K moment.
 *   B — A horizontal rail with a sliding chrome underline and a morphing spec column.
 *
 * All figures come from the authoritative catalog. Readability is never sacrificed
 * to the animation.
 */
import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { FAMILIES, type Family, usd, price } from '../catalog';
import { ParticleField, type ParticleFieldHandle } from '../ParticleField';
import { AnimatedNumber, MagneticButton } from './widgets';
import { SITE } from '../site';
import { goExternal } from '../components';

function specRows(a: Family['accounts'][number], fam: Family): JSX.Element {
  return (
    <div className="accA-rows">
      <div className="accA-row"><span className="l">Profit target</span><AnimatedNumber className="v" value={a.targetUsd} format={usd} /></div>
      <div className="accA-row"><span className="l">EOD drawdown</span><AnimatedNumber className="v" value={a.eodDrawdownUsd} format={usd} /></div>
      <div className="accA-row"><span className="l">Contracts</span><span className="v">{a.minis} minis · {a.micros} micros</span></div>
      {a.bufferUsd != null ? (
        <div className="accA-row"><span className="l">Payout buffer</span><AnimatedNumber className="v" value={a.bufferUsd} format={usd} /></div>
      ) : null}
      <div className="accA-row"><span className="l">Profit split</span><span className="v">{fam.splitPct}%</span></div>
      <div className="accA-row"><span className="l">Activation</span><span className="v">${fam.activationFeeUsd}</span></div>
    </div>
  );
}

export function AccountExpA(): JSX.Element {
  const [famIdx, setFamIdx] = useState(0);
  const [sizeIdx, setSizeIdx] = useState(0);
  const focus = useRef<ParticleFieldHandle | null>(null);
  const fam = FAMILIES[famIdx]!;
  const acct = fam.accounts[Math.min(sizeIdx, fam.accounts.length - 1)]!;
  const gold = acct.gold === true;

  const pick = (i: number): void => { setFamIdx(i); setSizeIdx(0); focus.current?.setFocus(0.5 + (i - 1) * 0.22, 0.4); };

  return (
    <section className="accA" data-gold={gold ? 'true' : 'false'}>
      <ParticleField className="accA-field" focusRef={focus} />
      <div className="accA-inner">
        <div className="ht-eyebrow" style={{ marginBottom: 22 }}>Configure your account</div>
        <div className="accA-words">
          {FAMILIES.map((f, i) => (
            <button
              key={f.key}
              className="accA-word"
              data-active={i === famIdx ? 'true' : 'false'}
              data-gold={f.accounts.some((a) => a.gold) && i === famIdx && gold ? 'true' : 'false'}
              onMouseEnter={() => focus.current?.setFocus(0.5 + (i - 1) * 0.22, 0.4)}
              onClick={() => pick(i)}
            >
              {f.name}
            </button>
          ))}
        </div>

        <div className="accA-panel">
          <div>
            <div className="accA-tag">{fam.tagline}</div>
            <p className="accA-sum">{fam.summary}</p>
            <div className="accA-sizes" role="tablist" aria-label="Account size">
              {fam.accounts.map((a, i) => (
                <button
                  key={a.size}
                  className="accA-size"
                  data-active={i === sizeIdx ? 'true' : 'false'}
                  data-gold={a.gold ? 'true' : 'false'}
                  onClick={() => setSizeIdx(i)}
                >
                  ${a.size}{a.gold ? ' Gold' : ''}
                </button>
              ))}
            </div>
          </div>

          <div className="accA-spec" data-gold={gold ? 'true' : 'false'}>
            <div className="accA-price">
              <AnimatedNumber className="num" value={acct.priceUsd} format={price} />
              <span className="per">one-time · {fam.name} ${acct.size}</span>
            </div>
            {specRows(acct, fam)}
            <div className="accA-cta">
              <MagneticButton variant={gold ? 'gold' : 'primary'} onClick={() => goExternal(SITE.routes.getStarted)}>
                Start {fam.name} ${acct.size}
              </MagneticButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function AccountExpB(): JSX.Element {
  const [famIdx, setFamIdx] = useState(0);
  const [sizeIdx, setSizeIdx] = useState(0);
  const railRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const underline = useRef<HTMLSpanElement | null>(null);
  const fam = FAMILIES[famIdx]!;
  const acct = fam.accounts[Math.min(sizeIdx, fam.accounts.length - 1)]!;
  const gold = acct.gold === true;

  const moveUnderline = (i: number): void => {
    const btn = btnRefs.current[i];
    const rail = railRef.current;
    const u = underline.current;
    if (!btn || !rail || !u) return;
    const br = btn.getBoundingClientRect();
    const rr = rail.getBoundingClientRect();
    u.style.width = `${br.width}px`;
    u.style.transform = `translateX(${br.left - rr.left}px)`;
  };
  // Position underline after layout / on family change.
  useLayoutMove(() => moveUnderline(famIdx), [famIdx]);

  return (
    <section className="accB" data-gold={gold ? 'true' : 'false'}>
      <div className="accB-inner">
        <div className="ht-eyebrow" style={{ marginBottom: 26 }}>Pick a program</div>
        <div className="accB-rail" ref={railRef}>
          {FAMILIES.map((f, i) => (
            <button
              key={f.key}
              ref={(el) => { btnRefs.current[i] = el; }}
              data-active={i === famIdx ? 'true' : 'false'}
              onClick={() => { setFamIdx(i); setSizeIdx(0); }}
            >
              {f.name}
            </button>
          ))}
          <span className="accB-underline" ref={underline} data-gold={gold ? 'true' : 'false'} />
        </div>

        <div className="accB-body">
          <div className="accB-sizes">
            {fam.accounts.map((a, i) => (
              <button
                key={a.size}
                className="accB-sizebtn"
                data-active={i === sizeIdx ? 'true' : 'false'}
                data-gold={a.gold ? 'true' : 'false'}
                onClick={() => setSizeIdx(i)}
              >
                <span className="s">${a.size}{a.gold ? ' Gold' : ''}</span>
                <span className="p">{price(a.priceUsd)}</span>
              </button>
            ))}
          </div>

          <div className="accB-detail">
            <h4>{fam.name} · ${acct.size}</h4>
            <div className="accB-stat"><div className="v"><AnimatedNumber value={acct.priceUsd} format={price} /></div><div className="l">One-time evaluation · $0 activation</div></div>
            <div className="accB-stat"><div className="v"><AnimatedNumber value={acct.targetUsd} format={usd} /></div><div className="l">Profit target</div></div>
            <div className="accB-stat"><div className="v"><AnimatedNumber value={acct.eodDrawdownUsd} format={usd} /></div><div className="l">End-of-day trailing drawdown</div></div>
            <div className="accB-stat"><div className="v">{acct.minis} / {acct.micros}</div><div className="l">Minis / micros</div></div>
            <div className="accB-stat"><div className="v">{fam.splitPct}%</div><div className="l">Trader profit split</div></div>
            <div style={{ marginTop: 22 }}>
              <MagneticButton variant={gold ? 'gold' : 'primary'} onClick={() => goExternal(SITE.routes.getStarted)}>
                Start {fam.name} ${acct.size}
              </MagneticButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Tiny layout-effect helper for positioning the sliding underline.
function useLayoutMove(fn: () => void, deps: unknown[]): void {
  useLayoutEffect(() => {
    fn();
    const onResize = (): void => fn();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
