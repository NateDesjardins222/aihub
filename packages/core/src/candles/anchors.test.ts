import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { requireInstrument } from '@atlas/instruments';
import { anchorsWithin, sessionAnchors } from './anchors.js';

const NQ = requireInstrument('NQ');
const CL = requireInstrument('CL');

function chicago(at: number): string {
  return DateTime.fromMillis(at, { zone: 'America/Chicago' }).toFormat('yyyy-MM-dd HH:mm');
}

describe('session anchors', () => {
  it('opens the session the evening before the trading date', () => {
    const open = sessionAnchors(NQ, '2026-09-15').find((a) => a.id === 'SESSION_OPEN')!;
    expect(chicago(open.at)).toBe('2026-09-14 17:00');
  });

  it('places the overnight anchors after the open, not before it', () => {
    const anchors = sessionAnchors(NQ, '2026-09-15');
    const open = anchors.find((a) => a.id === 'SESSION_OPEN')!;
    for (const anchor of anchors) expect(anchor.at).toBeGreaterThanOrEqual(open.at);

    // Asia is the evening of the 14th; London is the small hours of the 15th.
    expect(chicago(anchors.find((a) => a.id === 'ASIA')!.at)).toBe('2026-09-14 19:00');
    expect(chicago(anchors.find((a) => a.id === 'LONDON_OPEN')!.at)).toBe('2026-09-15 02:00');
  });

  it('puts the New York open at the cash open in Chicago time', () => {
    const ny = sessionAnchors(NQ, '2026-09-15').find((a) => a.id === 'NY_OPEN')!;
    expect(chicago(ny.at)).toBe('2026-09-15 08:30');
  });

  it('takes regular hours from the instrument rather than a constant', () => {
    const nq = sessionAnchors(NQ, '2026-09-15').find((a) => a.id === 'RTH_OPEN')!;
    const cl = sessionAnchors(CL, '2026-09-15').find((a) => a.id === 'RTH_OPEN')!;
    expect(nq.at).not.toBe(cl.at);
  });

  it('returns them in the order they happen', () => {
    const anchors = sessionAnchors(NQ, '2026-09-15');
    for (let i = 1; i < anchors.length; i += 1) {
      expect(anchors[i]!.at).toBeGreaterThanOrEqual(anchors[i - 1]!.at);
    }
  });

  it('keeps only the anchors a recording actually covers', () => {
    const all = sessionAnchors(NQ, '2026-09-15');
    const open = all.find((a) => a.id === 'SESSION_OPEN')!.at;
    const within = anchorsWithin(NQ, '2026-09-15', open + 3_600_000, open + 10 * 3_600_000);
    expect(within.some((a) => a.id === 'SESSION_OPEN')).toBe(false);
    expect(within.length).toBeGreaterThan(0);
    expect(within.every((a) => a.at >= open + 3_600_000)).toBe(true);
  });
});
