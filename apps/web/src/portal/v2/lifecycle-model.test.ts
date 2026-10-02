/**
 * The ONE lifecycle view model + Next Up engine (Customer Golden Path Phase 1, WEB-2).
 * Proves: determinism, authority (maps portalState, never recomputes business rules),
 * correct single-next-action selection across a multi-account customer, truthful copy,
 * and deterministic tie-breaking.
 */
import { describe, expect, it } from 'vitest';
import type { AccountSummary } from '../lib';
import { MICROS_PER_DOLLAR as M } from './format';
import type { AccountViewExtra } from './account-view';
import { buildLifecycleView, type LifecycleInput, type NextUpKind } from './lifecycle-model';

function acct(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: 'a1', publicId: 'HT-1005', name: 'Core 100K', nickname: null,
    accountType: 'EVALUATION', status: 'ACTIVE', portalState: 'EVALUATION_ACTIVE', consumesSlot: true,
    product: { key: 'core-100k', name: 'CORE 100K', version: 3 },
    startingBalanceMicros: 100_000 * M, balanceMicros: 100_000 * M, highWaterMarkMicros: 100_000 * M,
    drawdownFloorMicros: 96_000 * M, profitTargetMicros: 6_000 * M, resetOfAccountId: null, archivedAt: null, createdAt: 0,
    ...over,
  };
}

const NO_PROGRESS: LifecycleInput['progress'] = { lifetimePaidTraderShareMicros: 0, achievementsEarned: 0, currentClub: null };

function view(accounts: AccountSummary[], extras: Record<string, AccountViewExtra> = {}, progress: LifecycleInput['progress'] = NO_PROGRESS) {
  const input: LifecycleInput = {
    accounts,
    extraFor: (a) => extras[a.id],
    progress,
  };
  return buildLifecycleView(input);
}

describe('buildLifecycleView — determinism', () => {
  it('is pure: identical input yields deeply-equal output', () => {
    const accounts = [
      acct({ id: 'a1', portalState: 'EVALUATION_ACTIVE', balanceMicros: 103_000 * M }),
      acct({ id: 'a2', accountType: 'FUNDED_SIM', portalState: 'FUNDED_ACTIVE', createdAt: 1 }),
    ];
    const extras = { a2: { winningDays: 2, requiredWinningDays: 5 } };
    expect(view(accounts, extras)).toEqual(view(accounts, extras));
  });
});

describe('Next Up — single most important action', () => {
  it('picks REQUEST_PAYOUT over every lower-priority candidate', () => {
    const accounts = [
      acct({ id: 'eval', portalState: 'EVALUATION_ACTIVE' }),
      acct({ id: 'fund', accountType: 'FUNDED_SIM', portalState: 'FUNDED_ACTIVE' }),
      acct({ id: 'passed', portalState: 'EVALUATION_PASSED' }),
    ];
    const extras = { fund: { availableMicros: 2_000 * M, payoutState: 'ELIGIBLE' as const } };
    const v = view(accounts, extras);
    expect(v.nextUp?.kind).toBe('REQUEST_PAYOUT');
    expect(v.nextUp?.accountId).toBe('fund');
    expect(v.phase).toBe('PAYOUT_READY');
    expect(v.nextUp?.cta.target).toBe('payouts');
  });

  it('a funded account with no eligibility shows FUNDED_PROGRESS, not a payout', () => {
    const accounts = [acct({ id: 'f', accountType: 'FUNDED_SIM', portalState: 'FUNDED_ACTIVE' })];
    const v = view(accounts, { f: { winningDays: 3, requiredWinningDays: 5 } });
    expect(v.nextUp?.kind).toBe('FUNDED_PROGRESS');
    expect(v.nextUp?.detail).toContain('3 of 5 winning days');
    expect(v.nextUp?.progress).toBeCloseTo(0.6);
  });

  it('passed-but-not-funded surfaces FUNDING_IN_PROGRESS and phase QUALIFIED', () => {
    const v = view([acct({ portalState: 'EVALUATION_PASSED' })]);
    expect(v.nextUp?.kind).toBe('FUNDING_IN_PROGRESS');
    expect(v.phase).toBe('QUALIFIED');
  });

  it('an evaluation shows truthful profit-target progress, no urgency language', () => {
    const v = view([acct({ portalState: 'EVALUATION_ACTIVE', balanceMicros: 103_000 * M, profitTargetMicros: 6_000 * M })]);
    expect(v.nextUp?.kind).toBe('EVALUATION_PROGRESS');
    expect(v.nextUp?.detail).toBe('$3,000 of $6,000 profit target reached.');
    expect(v.nextUp?.progress).toBeCloseTo(0.5);
  });

  it('no accounts → GET_STARTED / ONBOARDING', () => {
    const v = view([]);
    expect(v.nextUp?.kind).toBe('GET_STARTED');
    expect(v.phase).toBe('ONBOARDING');
  });

  it('only terminal accounts with accomplishments → ESTABLISHED + VIEW_PROGRESS', () => {
    const v = view(
      [acct({ portalState: 'COMPLETED_MAX_PAYOUTS', status: 'COMPLETED', consumesSlot: false })],
      {},
      { lifetimePaidTraderShareMicros: 60_000 * M, achievementsEarned: 4, currentClub: 'FIFTYK_CLUB' },
    );
    expect(v.phase).toBe('ESTABLISHED');
    expect(v.nextUp?.kind).toBe('VIEW_PROGRESS');
    expect(v.phaseSummary).toContain('$60,000 paid');
  });

  it('only a breached evaluation, nothing accomplished → DORMANT, offers a fresh start', () => {
    const v = view([acct({ portalState: 'FAILED', status: 'FAILED', consumesSlot: false })]);
    expect(v.phase).toBe('DORMANT');
    expect(v.nextUp?.kind).toBe('GET_STARTED');
    // Breaches are owned by the dashboard banner, not the Next Up queue.
    expect(v.queue).toHaveLength(0);
  });
});

describe('Next Up — deterministic tie-break', () => {
  it('ties on priority break by createdAt then id', () => {
    const accounts = [
      acct({ id: 'zzz', portalState: 'EVALUATION_ACTIVE', createdAt: 100 }),
      acct({ id: 'aaa', portalState: 'EVALUATION_ACTIVE', createdAt: 50 }),
      acct({ id: 'mmm', portalState: 'EVALUATION_ACTIVE', createdAt: 50 }),
    ];
    const v = view(accounts);
    // Earliest createdAt wins; among equal createdAt, lexicographically-smaller id.
    expect(v.queue.map((q) => q.accountId)).toEqual(['aaa', 'mmm', 'zzz']);
    expect(v.nextUp?.accountId).toBe('aaa');
  });
});

describe('counts + authority', () => {
  it('counts every state and never recomputes portalState', () => {
    const accounts = [
      acct({ id: '1', portalState: 'PENDING', status: 'PENDING' }),
      acct({ id: '2', portalState: 'EVALUATION_ACTIVE' }),
      acct({ id: '3', portalState: 'EVALUATION_PASSED' }),
      acct({ id: '4', accountType: 'FUNDED_SIM', portalState: 'FUNDED_ACTIVE' }),
      acct({ id: '5', portalState: 'FAILED', status: 'FAILED', consumesSlot: false }),
      acct({ id: '6', portalState: 'COMPLETED_MAX_PAYOUTS', status: 'COMPLETED', consumesSlot: false }),
    ];
    const v = view(accounts);
    expect(v.counts).toEqual({
      pending: 1, evaluationsActive: 1, passed: 1, funded: 1, breached: 1, completed: 1, active: 4,
    });
  });

  it('copy never contains manipulative trading language', () => {
    const forbidden = /trade now|keep the streak|make it back|one more trade|don.t miss out|increase size/i;
    const accounts = [
      acct({ id: '1', portalState: 'EVALUATION_ACTIVE' }),
      acct({ id: '2', accountType: 'FUNDED_SIM', portalState: 'FUNDED_ACTIVE' }),
      acct({ id: '3', portalState: 'PENDING', status: 'PENDING' }),
      acct({ id: '4', portalState: 'EVALUATION_PASSED' }),
    ];
    const v = view(accounts, { 2: { winningDays: 1, requiredWinningDays: 5 } });
    for (const action of [...v.queue, v.nextUp!]) {
      expect(action.title).not.toMatch(forbidden);
      expect(action.detail).not.toMatch(forbidden);
    }
  });
});
