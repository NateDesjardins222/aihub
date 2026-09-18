/**
 * Chart Settings -> Price Motion.
 *
 * Two choices, named the way a trader would ask for them, in a section of its
 * own. It was previously three sliders inside "Simulation", which is why the
 * brief said twice that it could not be found - a setting nobody can locate is
 * not a setting.
 *
 * The distinction this panel has to make unmistakable: SMOOTH is a DRAWING
 * choice. It changes what happens between two genuine observations and nothing
 * else. Fills, stop and target triggering, order matching, P&L, risk, the
 * journal and the recorded market data are all computed server-side from the
 * genuine observations, in both modes, and no interpolated value is ever sent
 * anywhere. The panel says so rather than assuming the reader knows.
 */
import type { JSX } from 'react';
import { useMotion } from '../state/motion-store';
import { RAW_MOTION, DEFAULT_MOTION } from '../chart/motion';
import './PriceMotion.css';

export function PriceMotionSettings(): JSX.Element {
  const settings = useMotion((s) => s.settings);
  const set = useMotion((s) => s.set);
  const raw = settings.mode === 'RAW';

  return (
    <div className="pm-settings" data-testid="price-motion-settings">
      <div className="st-group-title">Price motion</div>

      <div className="pm-choices" role="radiogroup" aria-label="Price motion">
        <button
          className={`pm-choice ${raw ? 'pm-choice-on' : ''}`}
          role="radio"
          aria-checked={raw}
          data-testid="motion-raw"
          onClick={() => set(RAW_MOTION, null)}
        >
          <span className="pm-choice-title">Tick / Raw</span>
          <span className="pm-choice-body">
            Every genuine market observation is drawn the instant it arrives, and nothing is
            drawn in between. The candle steps.
          </span>
        </button>

        <button
          className={`pm-choice ${raw ? '' : 'pm-choice-on'}`}
          role="radio"
          aria-checked={!raw}
          data-testid="motion-smooth"
          onClick={() => set({ ...DEFAULT_MOTION, mode: 'SMOOTH' }, null)}
        >
          <span className="pm-choice-title">Fluid / Smooth</span>
          <span className="pm-choice-body">
            The drawn price eases from the last genuine observation towards the next one, so
            momentum reads the way it does on a live tape.
          </span>
        </button>
      </div>

      <p className="pm-note" data-testid="motion-guarantee">
        <b>Smooth is presentation only.</b> It never alters OHLC, market history, fills, stop or
        target triggering, order matching, P&amp;L, risk, journal data or recorded market data.
        Execution always uses genuine observations, in both modes. Every value the smoothing
        draws lies between two real observations, and it always lands exactly on the real one.
      </p>

      {raw ? null : (
        <div className="pm-tuning">
          <div className="st-group-title">How fluid</div>
          <label className="pm-row" htmlFor="pm-smoothing">
            <span>Smoothing</span>
            <input
              id="pm-smoothing"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.smoothing}
              onChange={(event) => set({ smoothing: Number(event.target.value) })}
            />
            <span className="num pm-value">{settings.smoothing.toFixed(2)}</span>
          </label>

          <label className="pm-row" htmlFor="pm-speed">
            <span>Speed</span>
            <input
              id="pm-speed"
              type="range"
              min={0.25}
              max={4}
              step={0.25}
              value={settings.animationSpeed}
              onChange={(event) => set({ animationSpeed: Number(event.target.value) })}
            />
            <span className="num pm-value">{settings.animationSpeed.toFixed(2)}x</span>
          </label>

          <label className="pm-row" htmlFor="pm-catchup">
            <span>Catch up within</span>
            <input
              id="pm-catchup"
              type="range"
              min={100}
              max={3000}
              step={100}
              value={settings.maxCatchUpMs}
              onChange={(event) => set({ maxCatchUpMs: Number(event.target.value) })}
            />
            <span className="num pm-value">{settings.maxCatchUpMs}ms</span>
          </label>
          <p className="st-note">
            The hard deadline by which the drawn price must equal the genuine one. The visual
            price may lag; it may not lie.
          </p>
        </div>
      )}
    </div>
  );
}
