/**
 * V5 catalog — Channels & Pitchforks: the Parallel Channel.
 *
 * Proves, without a browser, that the parallel channel is a REAL tool:
 * registered under a "Channels & Pitchforks" family (never a lone one-item
 * category), placed by three clicks, and hit-testable on BOTH rails and in the
 * band between them — with the hit geometry matching what the painter draws.
 */
import { describe, expect, it } from 'vitest';
import { TOOLS, toolDef, FAMILY_LABEL, toolsByFamily } from './registry';
import { ANCHOR_COUNT, STORED_ANCHORS, KIND_LABEL, hitTest, type Drawing, type Projection } from './model';

const projection: Projection = {
  width: 1000,
  height: 600,
  timeToX: (t: number) => t,
  priceToY: (p: number) => p,
  xToTime: (x: number) => x,
  yToPrice: (y: number) => y,
  xToIndex: (x: number) => x,
  timeToIndex: (t: number) => t,
  indexToTime: (i: number) => i,
} as unknown as Projection;

function channel(anchors: Array<{ time: number; price: number }>): Drawing {
  const def = toolDef('PARALLEL_CHANNEL')!;
  return {
    id: 'ch1',
    kind: 'PARALLEL_CHANNEL',
    symbol: 'NQ',
    anchors,
    style: {
      color: '#5b9dff',
      opacity: 1,
      width: 2,
      dash: 'SOLID',
      fillColor: '#5b9dff',
      fillOpacity: 0.06,
      filled: true,
      fontSize: 11,
      showPrice: false,
    },
    options: { ...def.options },
    text: '',
    locked: false,
    hidden: false,
    timeframes: [],
    createdAt: 0,
  } as unknown as Drawing;
}

describe('parallel channel is a real, wired tool', () => {
  it('is registered with a label and a three-click placement', () => {
    expect(TOOLS.find((t) => t.kind === 'PARALLEL_CHANNEL')).toBeTruthy();
    expect(KIND_LABEL.PARALLEL_CHANNEL).toBe('Parallel channel');
    expect(ANCHOR_COUNT.PARALLEL_CHANNEL).toBe(3);
    expect(STORED_ANCHORS.PARALLEL_CHANNEL).toBe(3);
    expect(toolDef('PARALLEL_CHANNEL')!.family).toBe('CHANNELS');
  });

  it('lives under a "Channels & Pitchforks" family, not a lone pitchfork category', () => {
    expect(FAMILY_LABEL.CHANNELS).toBe('Channels & Pitchforks');
    const group = toolsByFamily().find((g) => g.family === 'CHANNELS');
    expect(group, 'the channels group is shown now it has a tool').toBeTruthy();
    expect(group!.tools.some((t) => t.kind === 'PARALLEL_CHANNEL')).toBe(true);
    // There is no separate one-item PITCHFORK family.
    expect(FAMILY_LABEL).not.toHaveProperty('PITCHFORK');
  });

  it('hit-tests on the near rail, the far rail, and the band between', () => {
    // Base rail from (100,100) to (300,100) — flat — and a third anchor 60 below
    // sets the far rail at y≈160. The band is 100..160 between x 100..300.
    const c = channel([
      { time: 100, price: 100 },
      { time: 300, price: 100 },
      { time: 200, price: 160 },
    ]);
    expect(hitTest(c, projection, { x: 200, y: 100 }, false), 'near rail').toBeTruthy();
    expect(hitTest(c, projection, { x: 200, y: 160 }, false), 'far rail').toBeTruthy();
    expect(hitTest(c, projection, { x: 200, y: 130 }, false), 'inside band').toBeTruthy();
    expect(hitTest(c, projection, { x: 200, y: 260 }, false), 'below the band').toBeNull();
    expect(hitTest(c, projection, { x: 500, y: 130 }, false), 'past the span').toBeNull();
  });

  it('keeps the rails parallel when the base line is angled', () => {
    // Base rises from (100,100) to (300,300); third anchor 40 below the base at
    // its own x. The far rail must sit 40 below the base at EVERY x.
    const c = channel([
      { time: 100, price: 100 },
      { time: 300, price: 300 },
      { time: 200, price: 240 }, // base at x=200 is y=200, so offset = +40
    ]);
    // On the base rail at x=150 (base y=150).
    expect(hitTest(c, projection, { x: 150, y: 150 }, false), 'base at 150').toBeTruthy();
    // On the far rail at x=150 (should be y=190, offset carried).
    expect(hitTest(c, projection, { x: 150, y: 190 }, false), 'far at 150').toBeTruthy();
    // Above the base rail is outside.
    expect(hitTest(c, projection, { x: 150, y: 120 }, false), 'above the channel').toBeNull();
  });
});
