/**
 * Where a popover opens.
 *
 * The rule exists because the object tree's button sits at the foot of the
 * drawing rail: opening downwards from there left eleven objects in a 169px
 * slot with the "remove all" action below the fold.
 */
import { describe, expect, it } from 'vitest';
import { verticalPlacement } from './Popover';

const VIEWPORT = 1050;

describe('verticalPlacement', () => {
  it('opens downwards from a button near the top', () => {
    const place = verticalPlacement({ top: 40, bottom: 64 }, VIEWPORT);
    expect(place.side).toBe('below');
    expect(place.offset).toBe(67);
    expect(place.maxHeight).toBe(VIEWPORT - 64 - 13);
  });

  it('opens upwards from a button near the bottom', () => {
    // The object tree's button: 24px tall, 20px clear of the bottom edge.
    const place = verticalPlacement({ top: 1006, bottom: 1030 }, VIEWPORT);
    expect(place.side).toBe('above');
    // Measured from the viewport's bottom, so the panel's own bottom edge
    // sits just above the button.
    expect(place.offset).toBe(VIEWPORT - 1006 + 3);
    expect(place.maxHeight).toBe(1006 - 13);
  });

  it('stays below when the space below is merely snug but usable', () => {
    // 260px below: more than two rows and a heading, so no flip.
    const place = verticalPlacement({ top: 750, bottom: 777 }, VIEWPORT);
    expect(place.side).toBe('below');
  });

  it('picks the roomier side when both are cramped', () => {
    // 37px below, 87px above: neither fits, but the panel scrolls in the
    // taller of the two rather than in the shorter.
    const place = verticalPlacement({ top: 100, bottom: 950 }, 1000);
    expect(place.side).toBe('above');
  });

  it('does not flip when the space above is no better', () => {
    // 60px below, 47px above: flipping would gain nothing.
    const place = verticalPlacement({ top: 60, bottom: 917 }, 990);
    expect(place.side).toBe('below');
  });

  it('never returns a panel shorter than a usable minimum', () => {
    expect(verticalPlacement({ top: 8, bottom: 1040 }, VIEWPORT).maxHeight).toBe(160);
  });
});
