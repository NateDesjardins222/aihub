/**
 * Portal→Atlas handoff resolution (customer-system hardening §4A).
 *
 * The invariant under test, stated plainly:
 *
 *   If the Portal explicitly hands off account A (`/?account=<publicId>`), Atlas
 *   either selects A after verifying ownership, or it reports the requested
 *   account as unavailable. It must NEVER silently substitute account B as though
 *   the handoff had succeeded.
 *
 * Before this phase the resolver had NO test coverage and an unresolvable handoff
 * fell straight through to the remembered / practice / first account with no
 * signal that the requested account had been dropped — the fallback was passed
 * off as the account the customer asked for. These cases pin the fixed behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { ApiAccount } from '../api/types';
import { resolveAccountSelection } from './account-selection';

/** A minimal owner-scoped account — only the fields the resolver reads matter. */
function account(id: string, publicId: string, accountType = 'EVALUATION'): ApiAccount {
  return {
    id,
    publicId,
    name: `${publicId} account`,
    product: null,
    accountType,
    status: 'ACTIVE',
    ruleTemplate: {} as ApiAccount['ruleTemplate'],
    startingBalanceMicros: 0,
    balanceMicros: 0,
    realizedPnlMicros: 0,
    feesMicros: 0,
    highWaterMarkMicros: 0,
    drawdownFloorMicros: 0,
    equityMicros: 0,
    openPnlMicros: 0,
    dayPnlMicros: 0,
    remainingDrawdownMicros: 0,
    remainingDailyLossMicros: null,
    profitTargetProgressMicros: 0,
    tradingDaysCount: 0,
    currentTradeDate: null,
    failedReason: null,
    instrumentLimits: null,
    activatedAt: null,
    seq: 0,
    createdAt: 0,
  };
}

describe('resolveAccountSelection — Portal→Atlas handoff (§4A)', () => {
  it('selects exactly the handed-off account when it is owned and visible', () => {
    const accounts = [
      account('id-prac', 'SIM-PRAC', 'PRACTICE'),
      account('id-A', 'SIM-A'),
      account('id-B', 'SIM-B'),
    ];
    const r = resolveAccountSelection({ accounts, handoff: 'SIM-A', remembered: 'id-B' });
    expect(r.selectedAccountId).toBe('id-A');
    expect(r.handoffResolved).toBe(true);
    expect(r.handoffUnavailable).toBeNull();
  });

  it('a resolved handoff overrides both the remembered and the practice account', () => {
    const accounts = [
      account('id-prac', 'SIM-PRAC', 'PRACTICE'),
      account('id-A', 'SIM-A'),
    ];
    // Remembered points elsewhere, practice exists — the handoff still wins.
    const r = resolveAccountSelection({ accounts, handoff: 'SIM-A', remembered: 'id-prac' });
    expect(r.selectedAccountId).toBe('id-A');
    expect(r.handoffResolved).toBe(true);
  });

  it('CORE DEFECT: an unresolvable handoff is SURFACED, never silently swapped', () => {
    const accounts = [
      account('id-prac', 'SIM-PRAC', 'PRACTICE'),
      account('id-B', 'SIM-B'),
    ];
    // Portal linked SIM-GONE (now locked/failed/invisible). It is not in the
    // owner-scoped list. The terminal still needs an account to show, but it must
    // NOT pretend SIM-GONE was honoured.
    const r = resolveAccountSelection({ accounts, handoff: 'SIM-GONE', remembered: 'id-B' });
    expect(r.handoffResolved).toBe(false);
    expect(r.handoffUnavailable).toBe('SIM-GONE');
    // The fallback still picks an OWNED account so the terminal is usable...
    expect(r.selectedAccountId).toBe('id-B');
    // ...but it is reported as a fallback, not as the requested account.
    expect(r.selectedAccountId).not.toBe('SIM-GONE');
  });

  it('an unresolvable handoff with nothing remembered falls back to PRACTICE and still surfaces', () => {
    const accounts = [
      account('id-eval', 'SIM-EVAL'),
      account('id-prac', 'SIM-PRAC', 'PRACTICE'),
    ];
    const r = resolveAccountSelection({ accounts, handoff: 'SIM-GONE', remembered: null });
    expect(r.handoffUnavailable).toBe('SIM-GONE');
    expect(r.selectedAccountId).toBe('id-prac'); // practice preferred over first
  });

  it('an unresolvable handoff against an EMPTY list surfaces and selects nothing', () => {
    const r = resolveAccountSelection({ accounts: [], handoff: 'SIM-GONE', remembered: null });
    expect(r.handoffUnavailable).toBe('SIM-GONE');
    expect(r.selectedAccountId).toBeNull();
    expect(r.handoffResolved).toBe(false);
  });

  it('no handoff: remembered account is honoured when it still exists, no notice', () => {
    const accounts = [
      account('id-prac', 'SIM-PRAC', 'PRACTICE'),
      account('id-A', 'SIM-A'),
    ];
    const r = resolveAccountSelection({ accounts, handoff: null, remembered: 'id-A' });
    expect(r.selectedAccountId).toBe('id-A');
    expect(r.handoffUnavailable).toBeNull();
    expect(r.handoffResolved).toBe(false);
  });

  it('no handoff, stale remembered: falls back to PRACTICE without raising a handoff notice', () => {
    const accounts = [
      account('id-eval', 'SIM-EVAL'),
      account('id-prac', 'SIM-PRAC', 'PRACTICE'),
    ];
    const r = resolveAccountSelection({ accounts, handoff: null, remembered: 'id-vanished' });
    expect(r.selectedAccountId).toBe('id-prac');
    // Absence of a handoff must NOT raise the handoff notice, even on a fallback.
    expect(r.handoffUnavailable).toBeNull();
  });

  it('no handoff, nothing remembered, no practice: first account, no notice', () => {
    const accounts = [account('id-eval', 'SIM-EVAL'), account('id-B', 'SIM-B')];
    const r = resolveAccountSelection({ accounts, handoff: null, remembered: null });
    expect(r.selectedAccountId).toBe('id-eval');
    expect(r.handoffUnavailable).toBeNull();
  });
});
