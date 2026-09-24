/**
 * Reference-data services (M4-G/H/I) — session authority, symbology, rollover.
 * Pure/deterministic; no DB, no network.
 */
import { describe, expect, it } from 'vitest';
import { SessionAuthority } from './session-authority.js';
import { Symbology, SymbologyError } from './symbology.js';
import { RolloverEngine } from './rollover.js';

// A weekday mid-session instant well inside the 2025–2027 holiday coverage.
// 2026-06-15 is a Monday; 14:00 UTC ≈ 09:00 CT (RTH, market open).
const OPEN_TS = Date.parse('2026-06-15T14:00:00Z');
// Saturday — market closed.
const CLOSED_TS = Date.parse('2026-06-13T14:00:00Z');
// Outside the holiday calendar coverage (far future).
const UNCOVERED_TS = Date.parse('2035-06-16T14:00:00Z');

describe('SessionAuthority (M4-I)', () => {
  it('reports OPEN during a weekday session and CLOSED on the weekend', () => {
    const s = new SessionAuthority();
    const open = s.status('NQ', OPEN_TS);
    expect(open.state).toBe('OPEN');
    expect(open.authoritative).toBe(true);
    expect(open.exchange).toBe('CME');
    expect(s.status('NQ', CLOSED_TS).state).toBe('CLOSED');
  });

  it('reports UNKNOWN (not OPEN) outside the holiday-calendar coverage', () => {
    const s = new SessionAuthority();
    const st = s.status('NQ', UNCOVERED_TS);
    expect(st.state).toBe('UNKNOWN');
    expect(st.authoritative).toBe(false);
  });

  it('reports UNKNOWN for an unknown instrument, never throws', () => {
    const s = new SessionAuthority();
    expect(s.status('ZZZ', OPEN_TS).state).toBe('UNKNOWN');
  });

  it('honors a registered trading halt over the calendar, then clears it', () => {
    const s = new SessionAuthority();
    s.registerHalt('NQ', 'circuit breaker', OPEN_TS + 60_000);
    expect(s.status('NQ', OPEN_TS).state).toBe('HALTED');
    // Expired halt no longer applies.
    expect(s.status('NQ', OPEN_TS + 120_000).state).toBe('OPEN');
    s.registerHalt('NQ', 'manual', null);
    expect(s.status('NQ', OPEN_TS).state).toBe('HALTED');
    s.clearHalt('NQ');
    expect(s.status('NQ', OPEN_TS).state).toBe('OPEN');
  });
});

describe('Symbology (M4-G)', () => {
  const sym = new Symbology();

  it('maps Atlas root to a provider symbol and back', () => {
    expect(sym.toProviderSymbol('yahoo-delayed', 'NQ')).toBe('NQ=F');
    expect(sym.toProviderSymbol('databento', 'NQ')).toBe('NQ.c.0');
    expect(sym.toProviderSymbol('scripted', 'ES')).toBe('ES');
    expect(sym.toRoot('databento', 'NQ.c.0')).toBe('NQ');
    expect(sym.toRoot('scripted', 'ES')).toBe('ES');
    expect(sym.toRoot('databento', 'ZZ.c.0')).toBeNull();
  });

  it('resolves a contract-aware mapping at an instant', () => {
    const m = sym.resolve('databento', 'NQ', OPEN_TS);
    expect(m.root).toBe('NQ');
    expect(m.contractCode).toMatch(/^NQ[A-Z]\d\d$/);
  });

  it('rejects a contract code that does not belong to its root (NQ vs MNQ)', () => {
    // A specific NQ contract must never be executed under MNQ.
    expect(() => sym.assertExecutable('MNQ', 'NQZ26', OPEN_TS)).toThrow(SymbologyError);
    try {
      sym.assertExecutable('MNQ', 'NQZ26', OPEN_TS);
    } catch (e) {
      expect((e as SymbologyError).code).toBe('CONTRACT_ROOT_MISMATCH');
    }
  });

  it('accepts a contract code that belongs to its root', () => {
    const front = sym.resolve('scripted', 'NQ', OPEN_TS).contractCode!;
    expect(() => sym.assertExecutable('NQ', front, OPEN_TS)).not.toThrow();
  });

  it('throws on an unknown instrument', () => {
    expect(() => sym.toProviderSymbol('yahoo-delayed', 'ZZZ')).toThrow(SymbologyError);
  });
});

describe('RolloverEngine (M4-H)', () => {
  const roll = new RolloverEngine();

  it('reports front/next/previous contracts for a root', () => {
    const v = roll.view('NQ', OPEN_TS);
    expect(v.front.code).toMatch(/^NQ[A-Z]\d\d$/);
    expect(v.next.code).toMatch(/^NQ[A-Z]\d\d$/);
    expect(v.next.code).not.toBe(v.front.code);
    expect(v.previous).not.toBeNull();
    expect(v.previous!.code).not.toBe(v.front.code);
    expect(['STEADY', 'ROLL_WINDOW', 'EXPIRING']).toContain(v.phase);
  });

  it('advances the front contract across a roll boundary', () => {
    // Sample the front contract across a full year; it must change and never
    // reverse (the cycle is strictly increasing in time).
    const codes: string[] = [];
    for (let m = 0; m < 12; m += 1) {
      const ts = Date.parse('2026-01-15T14:00:00Z') + m * 30 * 24 * 3600_000;
      const code = roll.frontCode('NQ', ts);
      if (code && codes[codes.length - 1] !== code) codes.push(code);
    }
    // At least two distinct front months appear across the year (quarterly roll).
    expect(new Set(codes).size).toBeGreaterThanOrEqual(2);
  });

  it('next contract of a quarterly root is one cycle slot ahead', () => {
    const v = roll.view('NQ', OPEN_TS);
    // Quarterly months are Mar/Jun/Sep/Dec; front and next differ by 3 months
    // (mod 12), possibly crossing a year.
    const diff = (v.next.year * 12 + v.next.month) - (v.front.year * 12 + v.front.month);
    expect(diff).toBe(3);
  });
});
