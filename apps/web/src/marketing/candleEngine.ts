/*
 * Decorative synthetic market motion for the branded header.
 *
 * NOT real or live market data — it is a deterministic simulation used purely as a
 * visual. Every candle's full OHLC and its intra-candle tick path are a PURE
 * FUNCTION OF ITS INDEX (seeded PRNG), and the timeline is anchored to wall-clock
 * time. Two consequences that matter:
 *
 *   1. History already exists on arrival — the origin is set in the past, so the
 *      first paint shows a full chart, never an empty one.
 *   2. Rendering may pause (hidden tab, offscreen) and resume with no artifacts:
 *      the state at any moment is computed from `now`, so you never get a run of
 *      flat zero-range candles after switching back — the simulation "catches up".
 *
 * The renderer draws candles opaque (body over wick) and the strip is subdued via
 * element opacity, so a body always occludes its own wick.
 */

export interface Candle {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** The intra-candle price path; last element === close. */
  readonly ticks: readonly number[];
}

export interface PartialCandle {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  /** Current forming price (path value at the current tick). */
  readonly price: number;
  /** 0..1 progress through the bucket. */
  readonly progress: number;
}

export interface Frame {
  /** Completed candles for the visible window, oldest first. */
  readonly candles: readonly Candle[];
  /** The active (forming) candle. */
  readonly partial: PartialCandle;
  /** Absolute index of the active candle. */
  readonly activeIndex: number;
  /** Sub-bucket progress of the active candle, for smooth horizontal glide. */
  readonly progress: number;
}

export interface EngineConfig {
  /** Milliseconds per candle (default 3000 — a live ~3s chart). */
  readonly bucketMs?: number;
  /** Completed candles kept in the visible window. */
  readonly visible?: number;
  /** Ticks that form a single candle. */
  readonly ticksPerCandle?: number;
  /** Base per-candle volatility in synthetic points. */
  readonly baseVol?: number;
  /** Deterministic seed. */
  readonly seed?: number;
}

const DEFAULTS = { bucketMs: 3000, visible: 26, ticksPerCandle: 34, baseVol: 26, seed: 0x51ede7 };

function mulberry32(a: number): () => number {
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashIndex(i: number): number {
  // Mix the index into a well-distributed 32-bit seed.
  let h = (i + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Smooth value noise over the integer index, in [-1, 1]. Pure f(i). */
function valueNoise(i: number, seed: number): number {
  const K = 6; // wavelength of the coarse walk, in candles
  const cell = Math.floor(i / K);
  const frac = i / K - cell;
  const a = (mulberry32(seed ^ hashIndex(cell))() * 2 - 1);
  const b = (mulberry32(seed ^ hashIndex(cell + 1))() * 2 - 1);
  const s = frac * frac * (3 - 2 * frac); // smoothstep
  return a + (b - a) * s;
}

/** A bounded, trend-y baseline the candles open from. Pure f(i). NQ-ish level. */
function anchorLevel(i: number, seed: number): number {
  const base = 21_000;
  return (
    base +
    340 * Math.sin(i * 0.147 + 0.6) +
    180 * Math.sin(i * 0.361 + 2.1) +
    95 * Math.sin(i * 0.083 + 4.7) +
    260 * valueNoise(i, seed)
  );
}

interface Character {
  rangeMul: number;
  driftMul: number;
  tickVol: number;
}

/** The personality of a candle: small / medium / large / displacement / wicky / doji. */
function characterOf(r: number): Character {
  if (r < 0.1) return { rangeMul: 0.35, driftMul: 0.2, tickVol: 0.5 }; // doji-ish
  if (r < 0.4) return { rangeMul: 0.7, driftMul: 0.7, tickVol: 0.7 }; // small
  if (r < 0.72) return { rangeMul: 1.05, driftMul: 1.0, tickVol: 0.9 }; // medium
  if (r < 0.86) return { rangeMul: 1.7, driftMul: 1.15, tickVol: 1.1 }; // large
  if (r < 0.95) return { rangeMul: 2.5, driftMul: 1.9, tickVol: 0.85 }; // displacement
  return { rangeMul: 1.5, driftMul: 0.35, tickVol: 1.9 }; // wicky / whippy
}

export class CandleEngine {
  private readonly cfg: Required<EngineConfig>;
  private readonly originMs: number;
  private readonly cache = new Map<number, Candle>();

  constructor(config: EngineConfig = {}, now = Date.now()) {
    this.cfg = { ...DEFAULTS, ...config };
    // Anchor the origin in the past so a full history already exists at first paint.
    const historyBuckets = this.cfg.visible + 6;
    this.originMs = now - historyBuckets * this.cfg.bucketMs;
  }

  /** The full, immutable candle at absolute index i (cached). Pure f(i). */
  candle(i: number): Candle {
    const hit = this.cache.get(i);
    if (hit) return hit;

    const open = anchorLevel(i, this.cfg.seed);
    const target = anchorLevel(i + 1, this.cfg.seed);
    const rng = mulberry32(this.cfg.seed ^ hashIndex(i));
    const ch = characterOf(rng());

    const vol = this.cfg.baseVol * ch.rangeMul;
    // Drift toward the next anchor, amplified by character, with a seeded lean.
    const drift = (target - open) * ch.driftMul + (rng() - 0.5) * vol * 1.2;
    const n = this.cfg.ticksPerCandle;
    const ticks = new Array<number>(n);
    // The candle visibly starts at its open and forms tick-by-tick from there.
    let price = open;
    let high = open;
    let low = open;
    ticks[0] = open;
    for (let k = 1; k < n; k += 1) {
      const stepDrift = drift / (n - 1);
      const shock = (rng() * 2 - 1) * vol * ch.tickVol;
      price += stepDrift + shock;
      ticks[k] = price;
      if (price > high) high = price;
      if (price < low) low = price;
    }
    const candle: Candle = { open, high, low, close: ticks[n - 1]!, ticks };
    this.cache.set(i, candle);
    // Bounded cache: keep it from growing without limit over a long-lived tab.
    if (this.cache.size > 512) {
      const cutoff = i - 400;
      for (const key of this.cache.keys()) {
        if (key < cutoff) this.cache.delete(key);
      }
    }
    return candle;
  }

  activeIndex(now: number): number {
    return Math.floor((now - this.originMs) / this.cfg.bucketMs);
  }

  progress(now: number): number {
    const p = ((now - this.originMs) % this.cfg.bucketMs) / this.cfg.bucketMs;
    return p < 0 ? 0 : p;
  }

  /** The full render frame at `now` — pure function of `now`, so it self-heals. */
  frame(now: number): Frame {
    const active = this.activeIndex(now);
    const prog = this.progress(now);
    const start = active - this.cfg.visible;
    const candles: Candle[] = [];
    for (let i = start; i < active; i += 1) candles.push(this.candle(i));

    const cur = this.candle(active);
    const n = this.cfg.ticksPerCandle;
    const tickIdx = Math.min(n - 1, Math.floor(prog * n));
    let high = cur.open;
    let low = cur.open;
    for (let k = 0; k <= tickIdx; k += 1) {
      const v = cur.ticks[k]!;
      if (v > high) high = v;
      if (v < low) low = v;
    }
    const partial: PartialCandle = {
      open: cur.open,
      high,
      low,
      price: cur.ticks[tickIdx]!,
      progress: prog,
    };
    return { candles, partial, activeIndex: active, progress: prog };
  }

  get visible(): number {
    return this.cfg.visible;
  }
  get bucketMs(): number {
    return this.cfg.bucketMs;
  }
}
