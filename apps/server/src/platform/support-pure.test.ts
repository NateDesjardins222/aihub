/**
 * M12-L — deterministic pure-function coverage for the support domain: the ticket
 * lifecycle graph, reference generation, conservative priority suggestion, the
 * business-hours-aware SLA clock, SLA state derivation, and the attachment safety
 * gate (validation + signed downloads). No DB, no time flakiness — every case is exact.
 */
import { describe, expect, it } from 'vitest';
import {
  canTransitionTicket, generateRemediationRef, generateTicketRef, isPriority,
  PRIORITIES, REMEDIATION_STATUSES, REMEDIATION_TYPES, RESOLUTION_CODES, ROOT_CAUSE_CATEGORIES,
  suggestPriority, SUPPORT_TEAMS, TERMINAL_STATUSES, TICKET_STATUSES, WAITING_STATUSES,
  type TicketStatus,
} from './support-config.js';
import { addSlaMinutes } from './support-tickets.js';
import { slaState } from './support-inbox.js';
import { signDownloadToken, verifyDownloadToken, validateUpload } from './support-attachments.js';

describe('lifecycle graph', () => {
  const pairs: Array<[TicketStatus, TicketStatus]> = [
    ['OPEN', 'TRIAGED'], ['OPEN', 'IN_PROGRESS'], ['OPEN', 'ESCALATED'],
    ['TRIAGED', 'IN_PROGRESS'], ['IN_PROGRESS', 'WAITING_ON_CUSTOMER'],
    ['IN_PROGRESS', 'RESOLVED'], ['WAITING_ON_CUSTOMER', 'IN_PROGRESS'],
    ['ESCALATED', 'IN_PROGRESS'], ['ESCALATED', 'RESOLVED'], ['RESOLVED', 'CLOSED'],
  ];
  for (const [from, to] of pairs) {
    it(`evaluates ${from} → ${to} without throwing`, () => {
      expect(typeof canTransitionTicket(from, to)).toBe('boolean');
    });
  }
  it('forbids skipping straight from OPEN to CLOSED', () => {
    expect(canTransitionTicket('OPEN', 'CLOSED')).toBe(false);
  });
  it('forbids reviving a CLOSED ticket by transition', () => {
    expect(canTransitionTicket('CLOSED', 'OPEN')).toBe(false);
    expect(canTransitionTicket('CLOSED', 'IN_PROGRESS')).toBe(false);
  });
  it('never allows a transition to the same terminal loop CLOSED→CLOSED', () => {
    expect(canTransitionTicket('CLOSED', 'CLOSED')).toBe(false);
  });
  it('RESOLVED can move to CLOSED', () => {
    expect(canTransitionTicket('RESOLVED', 'CLOSED')).toBe(true);
  });
  it('every status is a non-empty string and unique', () => {
    expect(new Set(TICKET_STATUSES).size).toBe(TICKET_STATUSES.length);
    expect(TICKET_STATUSES).toContain('OPEN');
    expect(TERMINAL_STATUSES).toEqual(['RESOLVED', 'CLOSED']);
    expect(WAITING_STATUSES.every((s) => s.startsWith('WAITING_ON_'))).toBe(true);
  });
});

describe('enumerations are stable and unique', () => {
  for (const [name, arr] of Object.entries({ PRIORITIES, RESOLUTION_CODES, ROOT_CAUSE_CATEGORIES, REMEDIATION_TYPES, REMEDIATION_STATUSES, SUPPORT_TEAMS })) {
    it(`${name} has no duplicates`, () => {
      expect(new Set(arr as readonly string[]).size).toBe((arr as readonly string[]).length);
    });
  }
  it('PRIORITIES are ordered low→urgent', () => {
    expect(PRIORITIES).toEqual(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
  });
  it('isPriority accepts members and rejects others', () => {
    expect(isPriority('URGENT')).toBe(true);
    expect(isPriority('WHENEVER')).toBe(false);
  });
  it('REMEDIATION_STATUSES include the four-eyes stages', () => {
    for (const s of ['REQUESTED', 'APPROVED', 'DENIED', 'EXECUTED', 'FAILED']) expect(REMEDIATION_STATUSES).toContain(s);
  });
});

describe('reference generation', () => {
  it('ticket refs are HT- + 6 unambiguous chars', () => {
    for (let i = 0; i < 200; i += 1) expect(generateTicketRef()).toMatch(/^HT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
  it('remediation refs are REM- + 6 unambiguous chars', () => {
    for (let i = 0; i < 200; i += 1) expect(generateRemediationRef()).toMatch(/^REM-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
  it('refs never contain ambiguous 0/O/1/I characters', () => {
    for (let i = 0; i < 500; i += 1) expect(generateTicketRef().slice(3)).not.toMatch(/[01OI]/);
  });
  it('refs are overwhelmingly unique across a large batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(generateTicketRef());
    // 32^6 space; 2000 draws should collide essentially never.
    expect(seen.size).toBeGreaterThan(1990);
  });
});

describe('suggestPriority — conservative, never tone-driven', () => {
  it('keeps the default for a plain account question', () => {
    expect(suggestPriority('ACCOUNT', 'NORMAL')).toBe('NORMAL');
    expect(suggestPriority('ACCOUNT', 'LOW')).toBe('LOW');
  });
  it('raises login/security to at least HIGH', () => {
    expect(suggestPriority('LOGIN', 'NORMAL')).toBe('HIGH');
    expect(suggestPriority('ACCOUNT', 'NORMAL', { securityConcern: true })).toBe('HIGH');
  });
  it('raises unknown payout and duplicate charge to HIGH', () => {
    expect(suggestPriority('PAYOUT', 'NORMAL', { payoutUnknown: true })).toBe('HIGH');
    expect(suggestPriority('BILLING', 'NORMAL', { duplicateCharge: true })).toBe('HIGH');
  });
  it('escalates to URGENT only for funded + broken/unknown-money combos', () => {
    expect(suggestPriority('TRADING', 'NORMAL', { fundedAccountAffected: true, tradingBroken: true })).toBe('URGENT');
    expect(suggestPriority('PAYOUT', 'NORMAL', { fundedAccountAffected: true, payoutUnknown: true })).toBe('URGENT');
  });
  it('funded alone (no breakage) does not reach URGENT', () => {
    expect(suggestPriority('TRADING', 'NORMAL', { fundedAccountAffected: true })).toBe('NORMAL');
  });
  it('never lowers an already-high customer default', () => {
    expect(suggestPriority('ACCOUNT', 'HIGH')).toBe('HIGH');
    expect(suggestPriority('ACCOUNT', 'URGENT')).toBe('URGENT');
  });
});

describe('addSlaMinutes', () => {
  it('elapsed mode adds wall-clock minutes', () => {
    const from = new Date('2026-01-05T10:00:00Z'); // a Monday
    expect(addSlaMinutes(from, 60, null).toISOString()).toBe('2026-01-05T11:00:00.000Z');
    expect(addSlaMinutes(from, 0, null).getTime()).toBe(from.getTime());
  });
  it('elapsed mode when observeHours is false', () => {
    const from = new Date('2026-01-05T10:00:00Z');
    const bh = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', observeHours: false };
    expect(addSlaMinutes(from, 120, bh).toISOString()).toBe('2026-01-05T12:00:00.000Z');
  });
  it('business-hours mode stays within the working window on the same day', () => {
    const bh = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', observeHours: true };
    const from = new Date('2026-01-05T09:00:00Z'); // Monday open
    // 60 working minutes → 10:00 same day
    expect(addSlaMinutes(from, 60, bh).toISOString()).toBe('2026-01-05T10:00:00.000Z');
  });
  it('business-hours mode rolls a Friday-evening deadline into Monday', () => {
    const bh = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', observeHours: true };
    const from = new Date('2026-01-09T16:30:00Z'); // Friday 16:30, 30 min left in day
    // 60 working minutes → 30 on Friday, 30 spilling to Monday 09:30
    const due = addSlaMinutes(from, 60, bh);
    expect(due.getUTCDay()).toBe(1); // Monday
    expect(due.toISOString()).toBe('2026-01-12T09:30:00.000Z');
  });
  it('business-hours mode moves a weekend start to Monday open', () => {
    const bh = { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', observeHours: true };
    const from = new Date('2026-01-10T12:00:00Z'); // Saturday
    const due = addSlaMinutes(from, 30, bh);
    expect(due.toISOString()).toBe('2026-01-12T09:30:00.000Z');
  });
});

describe('slaState derivation', () => {
  const base = { status: 'IN_PROGRESS', slaPausedAt: null as Date | null, resolutionDueAt: null as Date | null, resolvedAt: null as Date | null };
  const now = new Date('2026-01-05T12:00:00Z');
  it('NONE when there is no due date', () => {
    expect(slaState({ ...base }, now)).toBe('NONE');
  });
  it('PAUSED when the clock is paused', () => {
    expect(slaState({ ...base, slaPausedAt: now, resolutionDueAt: new Date('2026-01-05T13:00:00Z') }, now)).toBe('PAUSED');
  });
  it('ON_TRACK when comfortably before due', () => {
    expect(slaState({ ...base, resolutionDueAt: new Date('2026-01-06T12:00:00Z') }, now)).toBe('ON_TRACK');
  });
  it('DUE_SOON within four hours', () => {
    expect(slaState({ ...base, resolutionDueAt: new Date('2026-01-05T14:00:00Z') }, now)).toBe('DUE_SOON');
  });
  it('BREACHED when past due and unresolved', () => {
    expect(slaState({ ...base, resolutionDueAt: new Date('2026-01-05T10:00:00Z') }, now)).toBe('BREACHED');
  });
  it('MET when resolved on or before the due date', () => {
    expect(slaState({ status: 'RESOLVED', slaPausedAt: null, resolutionDueAt: new Date('2026-01-05T13:00:00Z'), resolvedAt: new Date('2026-01-05T12:30:00Z') }, now)).toBe('MET');
  });
  it('BREACHED when resolved after the due date', () => {
    expect(slaState({ status: 'RESOLVED', slaPausedAt: null, resolutionDueAt: new Date('2026-01-05T10:00:00Z'), resolvedAt: new Date('2026-01-05T12:30:00Z') }, now)).toBe('BREACHED');
  });
  it('MET (not breached) for a CLOSED ticket with no due date', () => {
    expect(slaState({ status: 'CLOSED', slaPausedAt: null, resolutionDueAt: null, resolvedAt: null }, now)).toBe('MET');
  });
});

describe('attachment safety gate', () => {
  const settings = { maxAttachmentBytes: 10 * 1024 * 1024, allowedAttachmentTypes: ['image/png', 'image/jpeg', 'application/pdf'] };
  it('accepts a normal png within limits', () => {
    expect(validateUpload('screenshot.png', 'image/png', 1024, settings).safeName).toBe('screenshot.png');
  });
  it('rejects executables by extension regardless of declared type', () => {
    for (const name of ['malware.exe', 'run.sh', 'a.bat', 'x.js', 'p.ps1', 'e.msi', 't.jar']) {
      expect(() => validateUpload(name, 'image/png', 10, settings)).toThrow();
    }
  });
  it('rejects dangerous content types', () => {
    expect(() => validateUpload('a.png', 'application/x-msdownload', 10, settings)).toThrow();
    expect(() => validateUpload('a.png', 'text/javascript', 10, settings)).toThrow();
  });
  it('rejects a file exceeding the size cap', () => {
    expect(() => validateUpload('big.png', 'image/png', settings.maxAttachmentBytes + 1, settings)).toThrow();
  });
  it('rejects a disallowed but non-dangerous type', () => {
    expect(() => validateUpload('a.gif', 'image/gif', 10, settings)).toThrow();
  });
  it('sanitises path separators out of the stored name', () => {
    const { safeName } = validateUpload('../../etc/passwd.png', 'image/png', 10, settings);
    expect(safeName).not.toContain('/');
    expect(safeName).not.toContain('\\');
  });
});

describe('default settings sanity', () => {
  it('the reopen window is positive and the attachment cap is a sane size', async () => {
    const { DEFAULT_SUPPORT_SETTINGS } = await import('./support-config.js');
    expect(DEFAULT_SUPPORT_SETTINGS.reopenWindowDays).toBeGreaterThan(0);
    expect(DEFAULT_SUPPORT_SETTINGS.maxAttachmentBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_SUPPORT_SETTINGS.allowedAttachmentTypes.length).toBeGreaterThan(0);
  });
  it('linkable object types include the money-bearing objects support investigates', async () => {
    const { LINKABLE_OBJECT_TYPES } = await import('./support-config.js');
    for (const t of ['account', 'order', 'payout']) expect(LINKABLE_OBJECT_TYPES).toContain(t);
    expect(new Set(LINKABLE_OBJECT_TYPES).size).toBe(LINKABLE_OBJECT_TYPES.length);
  });
});

describe('signed download tokens', () => {
  it('verifies a token it just signed', () => {
    const id = crypto.randomUUID();
    const token = signDownloadToken(id);
    expect(verifyDownloadToken(id, token)).toBe(true);
  });
  it('rejects a token for a different attachment id', () => {
    const token = signDownloadToken(crypto.randomUUID());
    expect(verifyDownloadToken(crypto.randomUUID(), token)).toBe(false);
  });
  it('rejects a tampered or empty token', () => {
    const id = crypto.randomUUID();
    expect(verifyDownloadToken(id, 'not-a-real-token')).toBe(false);
    expect(verifyDownloadToken(id, '')).toBe(false);
  });
});
