/*
 * The chrome arrow — the recurring signature object.
 *
 * A physical-feeling chrome arrow rendered as SVG (no WebGL, no dependency). It
 * reads as a machined metal object photographed in a black studio: a banded chrome
 * gradient, a moving specular hotspot, a soft contact shadow and a raised bevel.
 *
 * It reacts to the cursor with weighted inertia (the object is heavy — it lags and
 * settles) and leans in 3D via perspective. Light travels across the surface as the
 * pointer moves. It never spins like a coin. Everything is driven through refs in a
 * single rAF loop; under reduced motion it renders a still, lit object.
 *
 * This is a proposed brand object for the design lab, not a change to any existing
 * mark.
 */
import { useRef, type JSX } from 'react';
import { lerp, prefersReduced, usePointer, useRaf } from './hooks';

export function ChromeArrow({
  size = 320,
  className,
  idle = true,
}: {
  size?: number;
  className?: string;
  /** Subtle idle float/rotation when the cursor is still. */
  idle?: boolean;
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null);
  const tilt = useRef<HTMLDivElement | null>(null);
  const mainGrad = useRef<SVGLinearGradientElement | null>(null);
  const spec = useRef<SVGRadialGradientElement | null>(null);
  const pointer = usePointer(host, true);

  // Smoothed animation state (kept out of React).
  const s = useRef({ rx: 0, ry: 0, gx: 0, gy: 0, rot: 0 });

  useRaf(host, (t) => {
    const p = pointer.current;
    const target = p.inside || Math.abs(p.x) < 1.6 ? p : { x: 0, y: 0 };
    // Heavy object: slow settle.
    s.current.ry = lerp(s.current.ry, target.x * 16, 0.06); // yaw from cursor x
    s.current.rx = lerp(s.current.rx, -target.y * 12, 0.06); // pitch from cursor y
    const floatY = idle ? Math.sin(t / 1400) * 8 : 0;
    const floatR = idle ? Math.sin(t / 2600) * 1.6 : 0;
    if (tilt.current) {
      tilt.current.style.transform =
        `translateY(${floatY.toFixed(2)}px) rotateX(${(s.current.rx).toFixed(2)}deg) ` +
        `rotateY(${(s.current.ry + floatR).toFixed(2)}deg)`;
    }
    // Light travels across the chrome: rotate the banded gradient + move the hotspot.
    s.current.rot = lerp(s.current.rot, target.x * 20, 0.05);
    if (mainGrad.current) mainGrad.current.setAttribute('gradientTransform', `rotate(${s.current.rot.toFixed(2)} 0.5 0.5)`);
    s.current.gx = lerp(s.current.gx, 0.5 + target.x * 0.32, 0.06);
    s.current.gy = lerp(s.current.gy, 0.34 + target.y * 0.26, 0.06);
    if (spec.current) {
      spec.current.setAttribute('cx', s.current.gx.toFixed(3));
      spec.current.setAttribute('cy', s.current.gy.toFixed(3));
      spec.current.setAttribute('fx', s.current.gx.toFixed(3));
      spec.current.setAttribute('fy', s.current.gy.toFixed(3));
    }
  });

  const reduce = prefersReduced();
  // The arrow polygon (points up): head + shaft.
  const arrow = '100,6 190,104 138,104 138,206 62,206 62,104 10,104';

  return (
    <div ref={host} className={`lab-chrome ${className ?? ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <div className="lab-chrome-glow" />
      <div ref={tilt} className="lab-chrome-tilt">
        <svg viewBox="0 0 200 212" width={size} height={size} className="lab-chrome-svg">
          <defs>
            <linearGradient
              id="chromeMain"
              ref={mainGrad}
              x1="0" y1="0" x2="0" y2="1"
              gradientUnits="objectBoundingBox"
              gradientTransform={reduce ? 'rotate(-8 0.5 0.5)' : undefined}
            >
              <stop offset="0" stopColor="#f7f9fc" />
              <stop offset="0.16" stopColor="#c6ccd6" />
              <stop offset="0.34" stopColor="#7f8693" />
              <stop offset="0.47" stopColor="#eef1f6" />
              <stop offset="0.53" stopColor="#cdd2db" />
              <stop offset="0.62" stopColor="#33363d" />
              <stop offset="0.74" stopColor="#8b919d" />
              <stop offset="0.88" stopColor="#d7dbe3" />
              <stop offset="1" stopColor="#717783" />
            </linearGradient>
            <radialGradient id="chromeSpec" ref={spec} cx="0.5" cy="0.32" r="0.5" fx="0.5" fy="0.32">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.92" />
              <stop offset="0.35" stopColor="#ffffff" stopOpacity="0.28" />
              <stop offset="0.7" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="chromeBevel" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.7" />
              <stop offset="0.5" stopColor="#ffffff" stopOpacity="0" />
              <stop offset="1" stopColor="#000000" stopOpacity="0.25" />
            </linearGradient>
            <filter id="chromeShadow" x="-40%" y="-30%" width="180%" height="200%">
              <feDropShadow dx="0" dy="18" stdDeviation="18" floodColor="#000000" floodOpacity="0.55" />
            </filter>
          </defs>

          <g filter="url(#chromeShadow)">
            <polygon points={arrow} fill="url(#chromeMain)" />
            {/* Raised bevel + a crisp edge highlight. */}
            <polygon points={arrow} fill="url(#chromeBevel)" opacity="0.6" />
            <polygon points={arrow} fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1" />
            {/* Moving specular hotspot, clipped to the arrow. */}
            <polygon points={arrow} fill="url(#chromeSpec)" />
          </g>
        </svg>
      </div>
      <div className="lab-chrome-contact" />
    </div>
  );
}
