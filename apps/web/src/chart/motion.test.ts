import { describe, expect, it } from 'vitest';
import { DEFAULT_MOTION, MarketMotion, RAW_MOTION, normalizeMotion } from './motion.js';
import type { NormalizedBar } from '@atlas/contracts';

/**
 * The motion layer is a DRAWING decision, so the tests are about what it is not
 * allowed to draw: a price outside the genuine data, a value that never
 * converges, or a smoothed figure surviving a switch to RAW.
 */

function bar(close: number, overrides: Partial<NormalizedBar> = {}): NormalizedBar {
  return {
    symbol: 'NQ',
    time: 1_000,
    open: 100,
    high: 110,
    low: 90,
    close,
    volume: 10,
    closed: false,
    ...overrides,
  };
}

describe('raw motion', () => {
  it('draws every observation exactly as it arrived', () => {
    const motion = new MarketMotion(RAW_MOTION, 0.25);
    motion.observe(bar(105), 0);
    expect(motion.sample(0)?.close).toBe(105);
    motion.observe(bar(101), 100);
    expect(motion.sample(100)?.close).toBe(101);
  });

  it('draws nothing when nothing changed', () => {
    const motion = new MarketMotion(RAW_MOTION, 0.25);
    motion.observe(bar(105), 0);
    motion.sample(0);
    expect(motion.sample(16)).toBeNull();
  });
});

describe('smooth motion', () => {
  it('never draws a price outside the two genuine observations', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, smoothing: 1 }, 0.25);
    motion.observe(bar(100, { open: 100 }), 0);
    motion.sample(0);
    motion.observe(bar(108), 100);

    for (let frame = 1; frame <= 60; frame += 1) {
      const drawn = motion.sample(100 + frame * 16)?.close;
      if (drawn === undefined) continue;
      expect(drawn).toBeGreaterThanOrEqual(100);
      expect(drawn).toBeLessThanOrEqual(108);
    }
  });

  it('never draws a price outside the bar that carries it', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, smoothing: 0.9 }, 0.25);
    motion.observe(bar(95, { open: 100, high: 110, low: 90 }), 0);
    motion.sample(0);
    motion.observe(bar(109, { open: 100, high: 110, low: 90 }), 50);

    for (let frame = 1; frame <= 80; frame += 1) {
      const drawn = motion.sample(50 + frame * 16);
      if (!drawn) continue;
      expect(drawn.close).toBeGreaterThanOrEqual(drawn.low);
      expect(drawn.close).toBeLessThanOrEqual(drawn.high);
      // The extremes themselves are the vendor's and are never touched.
      expect(drawn.high).toBe(110);
      expect(drawn.low).toBe(90);
      expect(drawn.open).toBe(100);
      expect(drawn.volume).toBe(10);
    }
  });

  it('always converges on the genuine price', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, smoothing: 1 }, 0.25);
    motion.observe(bar(100), 0);
    motion.sample(0);
    motion.observe(bar(140), 10);

    let now = 10;
    for (let frame = 0; frame < 400; frame += 1) {
      now += 16;
      motion.sample(now);
    }
    expect(motion.visualPrice()).toBe(140);
  });

  it('converges within the catch-up deadline however heavy the smoothing', () => {
    const motion = new MarketMotion(
      { mode: 'SMOOTH', smoothing: 1, animationSpeed: 0.25, maxCatchUpMs: 500 },
      0.25,
    );
    motion.observe(bar(100), 0);
    motion.sample(0);
    motion.observe(bar(200), 0);
    // One sample past the deadline is enough: the truth wins.
    motion.sample(501);
    expect(motion.visualPrice()).toBe(200);
  });

  it('starts a new bucket from that bar’s own open', () => {
    const motion = new MarketMotion(DEFAULT_MOTION, 0.25);
    motion.observe(bar(105, { time: 1_000 }), 0);
    motion.sample(0);
    motion.observe(bar(130, { time: 2_000, open: 128, high: 131, low: 127 }), 50);
    const drawn = motion.sample(66)!;
    // It eases from 128 toward 130, not from the previous bucket's 105.
    expect(drawn.close).toBeGreaterThanOrEqual(128);
    expect(drawn.close).toBeLessThanOrEqual(130);
  });
});

describe('settled bars', () => {
  it('draws a closed bar exactly, with no animation at all', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, smoothing: 1 }, 0.25);
    motion.observe(bar(100), 0);
    motion.sample(0);
    motion.observe(bar(140, { closed: true }), 10);
    // No easing: the bar is history and history is not animated.
    expect(motion.sample(10)?.close).toBe(140);
    expect(motion.visualPrice()).toBe(140);
  });
});

describe('switching modes', () => {
  it('snaps to the genuine price the moment RAW is selected', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, smoothing: 1 }, 0.25);
    motion.observe(bar(100), 0);
    motion.sample(0);
    motion.observe(bar(150), 10);
    motion.sample(26);
    expect(motion.visualPrice()).toBeLessThan(150);

    motion.setSettings({ mode: 'RAW' });
    expect(motion.visualPrice()).toBe(150);
  });

  it('keeps drawing from where it was when smoothing is turned up', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, smoothing: 0.2 }, 0.25);
    motion.observe(bar(100), 0);
    motion.sample(0);
    motion.observe(bar(120), 10);
    const before = motion.sample(26)!.close;
    motion.setSettings({ smoothing: 0.9 });
    const after = motion.sample(42)!.close;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThanOrEqual(120);
  });

  it('draws nothing at all before a genuine observation arrives', () => {
    const motion = new MarketMotion(DEFAULT_MOTION, 0.25);
    expect(motion.sample(1_000)).toBeNull();
    expect(motion.visualPrice()).toBeNull();
    expect(motion.genuine()).toBeNull();
  });

  it('forgets everything on reset, so a symbol change cannot bleed across', () => {
    const motion = new MarketMotion(DEFAULT_MOTION, 0.25);
    motion.observe(bar(105), 0);
    motion.sample(0);
    motion.reset();
    expect(motion.sample(16)).toBeNull();
    expect(motion.visualPrice()).toBeNull();
  });
});

describe('settings', () => {
  it('clamps anything a caller or a stored preference gets wrong', () => {
    const settings = normalizeMotion({
      mode: 'SMOOTH',
      smoothing: 4,
      animationSpeed: 0,
      maxCatchUpMs: -10,
    });
    expect(settings.smoothing).toBe(1);
    expect(settings.animationSpeed).toBe(0.25);
    expect(settings.maxCatchUpMs).toBe(0);
  });

  it('treats zero smoothing as raw', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, smoothing: 0 }, 0.25);
    motion.observe(bar(100), 0);
    motion.sample(0);
    motion.observe(bar(140), 10);
    expect(motion.sample(10)?.close).toBe(140);
  });
});

describe('keeping up with the replay', () => {
  /**
   * The same animation has to read well at half speed and at a hundred times
   * it. It does that by measuring how often prints are actually arriving and
   * sizing each move to land before the next one.
   */
  it('shortens its moves when prints arrive faster', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, maxCatchUpMs: 10_000 }, 0.25);

    // A slow feed: one print every two seconds.
    let now = 0;
    for (let i = 0; i < 6; i += 1) {
      now += 2_000;
      motion.observe(bar(100 + i, { time: 1_000 }), now);
      motion.sample(now);
    }
    const slowMove = motion.moveDurationMs();

    // The same feed, replayed a hundred times faster.
    for (let i = 0; i < 12; i += 1) {
      now += 20;
      motion.observe(bar(200 + i, { time: 1_000 }), now);
      motion.sample(now);
    }
    const fastMove = motion.moveDurationMs();

    expect(slowMove).toBeGreaterThan(fastMove * 4);
    expect(motion.observedCadenceMs()).toBeLessThan(500);
  });

  it('still lands exactly on the genuine price, whatever the cadence', () => {
    const motion = new MarketMotion({ ...DEFAULT_MOTION, maxCatchUpMs: 5_000 }, 0.25);
    let now = 0;
    for (let i = 0; i < 5; i += 1) {
      now += 40;
      motion.observe(bar(100, { time: 1_000 }), now);
      motion.sample(now);
    }

    motion.observe(bar(160, { time: 1_000 }), now);
    const move = motion.moveDurationMs();
    // Sampling past the end of the move gives the truth, never an approximation.
    motion.sample(now + move + 1);
    expect(motion.visualPrice()).toBe(160);
  });

  it('is time-based, so a faster screen does not animate faster', () => {
    const slow = new MarketMotion(DEFAULT_MOTION, 0.25);
    const fast = new MarketMotion(DEFAULT_MOTION, 0.25);
    slow.observe(bar(100, { time: 1_000 }), 0);
    fast.observe(bar(100, { time: 1_000 }), 0);
    slow.sample(0);
    fast.sample(0);
    slow.observe(bar(140, { time: 1_000 }), 100);
    fast.observe(bar(140, { time: 1_000 }), 100);

    // 60Hz: sampled every 16ms. 144Hz: every 7ms. Then both are asked where
    // they are at the SAME instant, and they must agree: the animation is a
    // function of elapsed time, not of how often it was asked.
    for (let t = 100; t < 200; t += 16) slow.sample(t);
    for (let t = 100; t < 200; t += 7) fast.sample(t);
    slow.sample(200);
    fast.sample(200);
    expect(Math.abs(slow.visualPrice()! - fast.visualPrice()!)).toBeLessThan(0.01);
  });
});
