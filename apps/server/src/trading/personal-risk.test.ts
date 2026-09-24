/**
 * Personal risk controls — pure evaluator / validator / comparator (M5).
 * Deterministic, no DB, no wall clock: the caller supplies all authoritative
 * inputs. These lock the semantics in docs/trader-risk-controls-semantics.md.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluatePersonalRisk,
  isStricter,
  validateControlValue,
  withinWindow,
  hhmmInZone,
  type PersonalConfig,
  type PersonalControl,
  type PersonalDayState,
  type PersonalRiskContext,
} from './personal-risk.js';
import type { PersonalControlType, PersonalControlValue } from '@atlas/contracts';

const M = 1_000_000;

function cfg(...controls: Array<Partial<PersonalControl> & { controlType: PersonalControlType }>): PersonalConfig {
  const map = new Map<PersonalControlType, PersonalControl>();
  for (const c of controls) {
    map.set(c.controlType, {
      enabled: true,
      mode: 'FLEXIBLE',
      lockedTradingDay: null,
      version: 0,
      valueMicros: null,
      valueInt: null,
      windowStart: null,
      windowEnd: null,
      sessions: null,
      ...c,
    });
  }
  return map;
}

const OPEN_TS = Date.parse('2026-06-15T14:00:00Z'); // Mon 09:00 CT
function ctx(over: Partial<PersonalRiskContext> = {}): PersonalRiskContext {
  return {
    positionQty: 0,
    side: 'BUY',
    qty: 1,
    dayPnlMicros: 0,
    equityMicros: 100_000 * M,
    marketNowMs: OPEN_TS,
    nowMs: OPEN_TS,
    sessionTimezone: 'America/Chicago',
    sessionState: 'OPEN',
    ...over,
  };
}
const NO_DAY: PersonalDayState = {
  openingTradeCount: 0,
  contractsOpened: 0,
  consecutiveLosses: 0,
  lastLossClosedAtMs: null,
  dayHighEquityMicros: null,
};

describe('never strand a position (the core safety semantic)', () => {
  it('P01 a reducing order is never blocked, even with every lock tripped', () => {
    const config = cfg(
      { controlType: 'MAX_TRADES', valueInt: 1 },
      { controlType: 'DAILY_LOSS_LIMIT', valueMicros: 100 * M },
      { controlType: 'COOLDOWN', valueInt: 30 },
    );
    const day = { ...NO_DAY, openingTradeCount: 5, consecutiveLosses: 9, lastLossClosedAtMs: OPEN_TS };
    // Long 3, selling 2 → pure reduction (increasing 0).
    const r = evaluatePersonalRisk(config, day, ctx({ positionQty: 3, side: 'SELL', qty: 2, dayPnlMicros: -500 * M }));
    expect(r).toBeNull();
  });

  it('P02 flattening a long is never blocked', () => {
    const config = cfg({ controlType: 'MAX_POSITION', valueInt: 1 });
    const r = evaluatePersonalRisk(config, NO_DAY, ctx({ positionQty: 5, side: 'SELL', qty: 5 }));
    expect(r).toBeNull();
  });

  it('P03 a reversal only blocks on the newly-opened portion', () => {
    // Long 2, selling 5 → closes 2, opens 3 short. Personal max position 2 → the
    // opened 3 exceeds it → blocked. (Firm gate ran earlier.)
    const config = cfg({ controlType: 'MAX_POSITION', valueInt: 2 });
    const r = evaluatePersonalRisk(config, NO_DAY, ctx({ positionQty: 2, side: 'SELL', qty: 5 }));
    expect(r?.reason).toBe('PERSONAL_MAX_POSITION');
  });
});

describe('max trades per day', () => {
  it('P04 blocks a new opening order at the cap', () => {
    const config = cfg({ controlType: 'MAX_TRADES', valueInt: 3 });
    const day = { ...NO_DAY, openingTradeCount: 3 };
    expect(evaluatePersonalRisk(config, day, ctx({ positionQty: 0 }))?.reason).toBe('PERSONAL_MAX_TRADES');
  });
  it('P05 allows opening below the cap', () => {
    const config = cfg({ controlType: 'MAX_TRADES', valueInt: 3 });
    expect(evaluatePersonalRisk(config, { ...NO_DAY, openingTradeCount: 2 }, ctx())).toBeNull();
  });
  it('P06 at the cap a reducing order still passes', () => {
    const config = cfg({ controlType: 'MAX_TRADES', valueInt: 3 });
    const day = { ...NO_DAY, openingTradeCount: 3 };
    expect(evaluatePersonalRisk(config, day, ctx({ positionQty: 2, side: 'SELL', qty: 1 }))).toBeNull();
  });
  it('P07 a disabled control never blocks', () => {
    const config = cfg({ controlType: 'MAX_TRADES', valueInt: 1, enabled: false });
    expect(evaluatePersonalRisk(config, { ...NO_DAY, openingTradeCount: 9 }, ctx())).toBeNull();
  });
});

describe('daily contract limit', () => {
  it('P08 blocks when opened + increasing exceeds the limit', () => {
    const config = cfg({ controlType: 'DAILY_CONTRACT_LIMIT', valueInt: 10 });
    const day = { ...NO_DAY, contractsOpened: 8 };
    expect(evaluatePersonalRisk(config, day, ctx({ qty: 3 }))?.reason).toBe('PERSONAL_DAILY_CONTRACT_LIMIT');
  });
  it('P09 allows exactly reaching the limit', () => {
    const config = cfg({ controlType: 'DAILY_CONTRACT_LIMIT', valueInt: 10 });
    expect(evaluatePersonalRisk(config, { ...NO_DAY, contractsOpened: 8 }, ctx({ qty: 2 }))).toBeNull();
  });
});

describe('max position size', () => {
  it('P10 blocks when projected exposure exceeds personal max', () => {
    const config = cfg({ controlType: 'MAX_POSITION', valueInt: 3 });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ positionQty: 2, qty: 2 }))?.reason).toBe('PERSONAL_MAX_POSITION');
  });
  it('P11 allows exactly the personal max', () => {
    const config = cfg({ controlType: 'MAX_POSITION', valueInt: 3 });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ positionQty: 2, qty: 1 }))).toBeNull();
  });
});

describe('daily loss limit', () => {
  it('P12 blocks new exposure once the day loss reaches the limit', () => {
    const config = cfg({ controlType: 'DAILY_LOSS_LIMIT', valueMicros: 500 * M });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ dayPnlMicros: -500 * M }))?.reason).toBe('PERSONAL_DAILY_LOSS_LIMIT');
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ dayPnlMicros: -600 * M }))?.reason).toBe('PERSONAL_DAILY_LOSS_LIMIT');
  });
  it('P13 allows while still above the limit', () => {
    const config = cfg({ controlType: 'DAILY_LOSS_LIMIT', valueMicros: 500 * M });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ dayPnlMicros: -499 * M }))).toBeNull();
  });
});

describe('daily profit lock', () => {
  it('P14 locks new exposure once the day profit reaches the threshold', () => {
    const config = cfg({ controlType: 'PROFIT_LOCK', valueMicros: 1_000 * M });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ dayPnlMicros: 1_000 * M }))?.reason).toBe('PERSONAL_PROFIT_LOCK');
  });
  it('P15 allows below the threshold', () => {
    const config = cfg({ controlType: 'PROFIT_LOCK', valueMicros: 1_000 * M });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ dayPnlMicros: 999 * M }))).toBeNull();
  });
});

describe('daily drawdown', () => {
  it('P16 blocks when high-water minus equity reaches the limit', () => {
    const config = cfg({ controlType: 'DAILY_DRAWDOWN', valueMicros: 800 * M });
    const day = { ...NO_DAY, dayHighEquityMicros: 101_000 * M };
    expect(evaluatePersonalRisk(config, day, ctx({ equityMicros: 100_200 * M }))?.reason).toBe('PERSONAL_DAILY_DRAWDOWN');
  });
  it('P17 does not fabricate a drawdown when equity is unmarkable', () => {
    const config = cfg({ controlType: 'DAILY_DRAWDOWN', valueMicros: 1 * M });
    const day = { ...NO_DAY, dayHighEquityMicros: 101_000 * M };
    expect(evaluatePersonalRisk(config, day, ctx({ equityMicros: null }))).toBeNull();
  });
});

describe('consecutive loss lock', () => {
  it('P18 blocks at the streak limit', () => {
    const config = cfg({ controlType: 'CONSECUTIVE_LOSS_LOCK', valueInt: 2 });
    expect(evaluatePersonalRisk(config, { ...NO_DAY, consecutiveLosses: 2 }, ctx())?.reason).toBe('PERSONAL_CONSECUTIVE_LOSS_LOCK');
  });
  it('P19 allows below the streak limit', () => {
    const config = cfg({ controlType: 'CONSECUTIVE_LOSS_LOCK', valueInt: 2 });
    expect(evaluatePersonalRisk(config, { ...NO_DAY, consecutiveLosses: 1 }, ctx())).toBeNull();
  });
});

describe('loss cooldown', () => {
  it('P20 blocks while the cooldown window is open', () => {
    const config = cfg({ controlType: 'COOLDOWN', valueInt: 30 });
    const day = { ...NO_DAY, lastLossClosedAtMs: OPEN_TS };
    // 10 minutes later, cooldown is 30m.
    expect(evaluatePersonalRisk(config, day, ctx({ nowMs: OPEN_TS + 10 * 60_000 }))?.reason).toBe('PERSONAL_COOLDOWN');
  });
  it('P21 allows once the cooldown has elapsed', () => {
    const config = cfg({ controlType: 'COOLDOWN', valueInt: 30 });
    const day = { ...NO_DAY, lastLossClosedAtMs: OPEN_TS };
    expect(evaluatePersonalRisk(config, day, ctx({ nowMs: OPEN_TS + 31 * 60_000 }))).toBeNull();
  });
  it('P22 with no prior loss, cooldown never blocks', () => {
    const config = cfg({ controlType: 'COOLDOWN', valueInt: 30 });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx())).toBeNull();
  });
});

describe('trading window', () => {
  it('P23 blocks outside the window and allows inside (exchange tz)', () => {
    // OPEN_TS is 09:00 CT.
    const inside = cfg({ controlType: 'TRADING_WINDOW', windowStart: '08:30', windowEnd: '12:00' });
    const outside = cfg({ controlType: 'TRADING_WINDOW', windowStart: '10:00', windowEnd: '12:00' });
    expect(evaluatePersonalRisk(inside, NO_DAY, ctx())).toBeNull();
    expect(evaluatePersonalRisk(outside, NO_DAY, ctx())?.reason).toBe('PERSONAL_TRADING_WINDOW');
  });
  it('P24 window helper handles wrap-around midnight', () => {
    expect(withinWindow('23:30', '22:00', '02:00')).toBe(true);
    expect(withinWindow('01:00', '22:00', '02:00')).toBe(true);
    expect(withinWindow('12:00', '22:00', '02:00')).toBe(false);
  });
  it('P25 hhmmInZone is deterministic', () => {
    expect(hhmmInZone(OPEN_TS, 'America/Chicago')).toBe('09:00');
    expect(hhmmInZone(OPEN_TS, 'UTC')).toBe('14:00');
  });
});

describe('session restriction', () => {
  it('P26 blocks when the current session is not allowed', () => {
    const config = cfg({ controlType: 'SESSION_RESTRICTION', sessions: ['OPEN'] });
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ sessionState: 'PRE_OPEN' }))?.reason).toBe('PERSONAL_SESSION_RESTRICTION');
    expect(evaluatePersonalRisk(config, NO_DAY, ctx({ sessionState: 'OPEN' }))).toBeNull();
  });
});

describe('composition + short-circuit', () => {
  it('P27 with no controls configured, nothing is blocked', () => {
    expect(evaluatePersonalRisk(new Map(), NO_DAY, ctx({ dayPnlMicros: -9_999 * M }))).toBeNull();
  });
  it('P28 the most-restrictive breach is reported (time/session before counters)', () => {
    const config = cfg(
      { controlType: 'TRADING_WINDOW', windowStart: '10:00', windowEnd: '12:00' },
      { controlType: 'MAX_TRADES', valueInt: 1 },
    );
    // Outside the window AND over the trade cap → window reported first (cheapest).
    expect(evaluatePersonalRisk(config, { ...NO_DAY, openingTradeCount: 5 }, ctx())?.reason).toBe('PERSONAL_TRADING_WINDOW');
  });
});

describe('validation', () => {
  const bad = (t: PersonalControlType, v: PersonalControlValue): boolean => validateControlValue(t, v) !== null;
  it('P29 rejects negative / zero / NaN / oversized currency', () => {
    expect(bad('DAILY_LOSS_LIMIT', { valueMicros: -1 })).toBe(true);
    expect(bad('DAILY_LOSS_LIMIT', { valueMicros: 0 })).toBe(true);
    expect(bad('DAILY_LOSS_LIMIT', { valueMicros: Number.NaN })).toBe(true);
    expect(bad('DAILY_LOSS_LIMIT', { valueMicros: 2e18 })).toBe(true);
    expect(bad('DAILY_LOSS_LIMIT', { valueMicros: 500 * M })).toBe(false);
  });
  it('P30 rejects non-integer / zero counts', () => {
    expect(bad('MAX_TRADES', { valueInt: 0 })).toBe(true);
    expect(bad('MAX_TRADES', { valueInt: 1.5 })).toBe(true);
    expect(bad('MAX_TRADES', { valueInt: 3 })).toBe(false);
  });
  it('P31 rejects malformed / equal trading windows', () => {
    expect(bad('TRADING_WINDOW', { windowStart: '9:00', windowEnd: '12:00' })).toBe(true);
    expect(bad('TRADING_WINDOW', { windowStart: '25:00', windowEnd: '12:00' })).toBe(true);
    expect(bad('TRADING_WINDOW', { windowStart: '09:00', windowEnd: '09:00' })).toBe(true);
    expect(bad('TRADING_WINDOW', { windowStart: '09:00', windowEnd: '12:00' })).toBe(false);
  });
  it('P32 rejects empty / unknown session sets', () => {
    expect(bad('SESSION_RESTRICTION', { sessions: [] })).toBe(true);
    expect(bad('SESSION_RESTRICTION', { sessions: ['LUNCH'] })).toBe(true);
    expect(bad('SESSION_RESTRICTION', { sessions: ['OPEN'] })).toBe(false);
  });
});

describe('isStricter (tighten-only for locked controls)', () => {
  it('P33 smaller currency limit is stricter; larger is not', () => {
    expect(isStricter('DAILY_LOSS_LIMIT', { valueMicros: 500 * M }, { valueMicros: 400 * M })).toBe(true);
    expect(isStricter('DAILY_LOSS_LIMIT', { valueMicros: 500 * M }, { valueMicros: 700 * M })).toBe(false);
  });
  it('P34 smaller count is stricter; larger is not', () => {
    expect(isStricter('MAX_TRADES', { valueInt: 3 }, { valueInt: 2 })).toBe(true);
    expect(isStricter('MAX_TRADES', { valueInt: 3 }, { valueInt: 4 })).toBe(false);
  });
  it('P35 longer cooldown is stricter', () => {
    expect(isStricter('COOLDOWN', { valueInt: 30 }, { valueInt: 45 })).toBe(true);
    expect(isStricter('COOLDOWN', { valueInt: 30 }, { valueInt: 15 })).toBe(false);
  });
  it('P36 narrower trading window is stricter', () => {
    expect(isStricter('TRADING_WINDOW', { windowStart: '08:00', windowEnd: '16:00' }, { windowStart: '09:00', windowEnd: '15:00' })).toBe(true);
    expect(isStricter('TRADING_WINDOW', { windowStart: '08:00', windowEnd: '16:00' }, { windowStart: '07:00', windowEnd: '16:00' })).toBe(false);
  });
  it('P37 a subset of sessions is stricter', () => {
    expect(isStricter('SESSION_RESTRICTION', { sessions: ['OPEN', 'PRE_OPEN'] }, { sessions: ['OPEN'] })).toBe(true);
    expect(isStricter('SESSION_RESTRICTION', { sessions: ['OPEN'] }, { sessions: ['OPEN', 'PRE_OPEN'] })).toBe(false);
  });
});
