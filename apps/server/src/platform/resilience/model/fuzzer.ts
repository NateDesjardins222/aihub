/**
 * State-machine fuzzer (Engineering Resilience Phase 3).
 *
 * A seeded generator drives the lifecycle+payout {@link Sim} through valid, invalid,
 * duplicate, stale and malformed actions, running the invariant oracle after each
 * meaningful transition. Every run records a CONCRETE, replayable action log so a
 * failure can be reproduced from its seed and reduced (remove-range delta debugging)
 * to a minimal failing sequence.
 *
 * Optimised for STATE SPACE EXPLORED and INVARIANTS PROVEN, not test count.
 */
import type { Database } from '../../../db/client.js';
import { Prng } from './prng.js';
import { Sim, $ } from './sim.js';

export type ActionName =
  | 'CREATE_CUSTOMER' | 'PROVISION_EVAL' | 'PROVISION_ENFORCED' | 'REPLAY_PROVISION'
  | 'FAIL_EVAL' | 'RESET' | 'CERTIFY' | 'FUND'
  | 'PAYOUT_ELIGIBLE' | 'REQUEST_PAYOUT' | 'DUP_REQUEST' | 'APPROVE_PAYOUT'
  | 'PROVIDER_PAID' | 'PROVIDER_FAILED' | 'DUP_CALLBACK' | 'RETRY_FAIL'
  | 'MALFORMED';

/** A concrete, replayable step: an action plus ordinals into deterministically-sorted pools. */
export interface Step { name: ActionName; a?: number; b?: number; c?: number }

export interface RunResult {
  seed: number;
  transitions: number;
  checks: number;
  digest: string;
  steps: Step[];
}

export class FuzzFailure extends Error {
  constructor(
    readonly seed: number,
    readonly stepIndex: number,
    readonly violations: string[],
    readonly steps: Step[],
    readonly context: string,
  ) {
    super(`seed=${seed} step=${stepIndex} violations=[${violations.join(' | ')}]`);
    this.name = 'FuzzFailure';
  }
}

/**
 * Pools in INSERTION ORDER (never sorted by uuid — uuids are random per run, so a
 * seed must select entities by the order they were created, which is deterministic
 * for a given seed). This is what makes same-seed → same-digest hold.
 */
function pools(sim: Sim) {
  const all = [...sim.accounts.values()]; // Map preserves insertion order
  return {
    users: [...sim.userIds],
    activeEvals: all.filter((x) => x.role === 'EVAL' && x.status === 'ACTIVE').map((x) => x.id),
    failedEvals: all.filter((x) => x.role === 'EVAL' && x.status === 'FAILED').map((x) => x.id),
    unfundedQuals: [...sim.quals.entries()].filter(([, q]) => !q.funded).map(([id]) => id),
    funded: all.filter((x) => x.role === 'FUNDED').map((x) => x.id),
    requests: [...sim.payouts.keys()],
  };
}

const WEIGHTS: readonly (readonly [ActionName, number])[] = [
  ['CREATE_CUSTOMER', 3], ['PROVISION_EVAL', 8], ['PROVISION_ENFORCED', 6], ['REPLAY_PROVISION', 4],
  ['FAIL_EVAL', 5], ['RESET', 6], ['CERTIFY', 6], ['FUND', 6],
  ['PAYOUT_ELIGIBLE', 4], ['REQUEST_PAYOUT', 6], ['DUP_REQUEST', 3], ['APPROVE_PAYOUT', 6],
  ['PROVIDER_PAID', 5], ['PROVIDER_FAILED', 5], ['DUP_CALLBACK', 4], ['RETRY_FAIL', 3],
  ['MALFORMED', 3],
];

/** Choose the concrete step to run next from the current pool, using the PRNG. */
function chooseStep(sim: Sim, rng: Prng): Step {
  const p = pools(sim);
  const name = rng.weighted(WEIGHTS);
  switch (name) {
    case 'CREATE_CUSTOMER': return { name };
    case 'PROVISION_EVAL':
    case 'PROVISION_ENFORCED':
      return { name, a: p.users.length ? rng.int(0, p.users.length - 1) : -1 };
    case 'REPLAY_PROVISION':
      return { name, a: p.users.length ? rng.int(0, p.users.length - 1) : -1 };
    case 'FAIL_EVAL': return { name, a: p.activeEvals.length ? rng.int(0, p.activeEvals.length - 1) : -1 };
    case 'RESET': return { name, a: p.failedEvals.length ? rng.int(0, p.failedEvals.length - 1) : -1 };
    case 'CERTIFY': return { name, a: p.activeEvals.length ? rng.int(0, p.activeEvals.length - 1) : -1 };
    case 'FUND': return { name, a: p.unfundedQuals.length ? rng.int(0, p.unfundedQuals.length - 1) : -1 };
    case 'PAYOUT_ELIGIBLE':
    case 'REQUEST_PAYOUT':
      return { name, a: p.funded.length ? rng.int(0, p.funded.length - 1) : -1 };
    case 'DUP_REQUEST': return { name, a: p.funded.length ? rng.int(0, p.funded.length - 1) : -1 };
    case 'APPROVE_PAYOUT':
    case 'PROVIDER_PAID':
    case 'PROVIDER_FAILED':
    case 'DUP_CALLBACK':
    case 'RETRY_FAIL':
      return { name, a: p.requests.length ? rng.int(0, p.requests.length - 1) : -1 };
    case 'MALFORMED': return { name, a: rng.int(0, 4) };
    default: return { name: 'CREATE_CUSTOMER' };
  }
}

/** Apply one concrete step. Returns true if it was a meaningful (attempted) transition. */
async function applyStep(sim: Sim, step: Step): Promise<boolean> {
  const p = pools(sim);
  const at = <T>(arr: readonly T[], i: number | undefined): T | undefined => (i === undefined || i < 0 || i >= arr.length ? undefined : arr[i]);
  switch (step.name) {
    case 'CREATE_CUSTOMER': await sim.createCustomer(`c${sim.userIds.length}`); return true;
    case 'PROVISION_EVAL': { const u = at(p.users, step.a); if (!u) return false; await sim.provisionEval(u, { enforceLimit: false }); return true; }
    case 'PROVISION_ENFORCED': { const u = at(p.users, step.a); if (!u) return false; await sim.provisionEval(u, { enforceLimit: true }); return true; }
    case 'REPLAY_PROVISION': { const u = at(p.users, step.a); if (!u) return false; await sim.replayProvision(u, `replay-${u}`); return true; }
    case 'FAIL_EVAL': { const id = at(p.activeEvals, step.a); if (!id) return false; await sim.failEval(sim.accounts.get(id)!); return true; }
    case 'RESET': { const id = at(p.failedEvals, step.a); if (!id) return false; await sim.reset(sim.accounts.get(id)!); return true; }
    case 'CERTIFY': { const id = at(p.activeEvals, step.a); if (!id) return false; await sim.certify(sim.accounts.get(id)!); return true; }
    case 'FUND': { const q = at(p.unfundedQuals, step.a); if (!q) return false; await sim.fund(q); return true; }
    case 'PAYOUT_ELIGIBLE': { const id = at(p.funded, step.a); if (!id) return false; await sim.makePayoutEligible(sim.accounts.get(id)!); return true; }
    case 'REQUEST_PAYOUT': { const id = at(p.funded, step.a); if (!id) return false; await sim.requestPayoutFor(sim.accounts.get(id)!); return true; }
    case 'DUP_REQUEST': { const id = at(p.funded, step.a); if (!id) return false; await sim.requestPayoutFor(sim.accounts.get(id)!, $(1000), `dupreq-${id}`); return true; }
    case 'APPROVE_PAYOUT': { const r = at(p.requests, step.a); if (!r) return false; await sim.approveAndSubmit(r); return true; }
    case 'PROVIDER_PAID': { const r = at(p.requests, step.a); if (!r) return false; await sim.providerEvent(r, 'PAID'); return true; }
    case 'PROVIDER_FAILED': { const r = at(p.requests, step.a); if (!r) return false; await sim.providerEvent(r, 'FAILED'); return true; }
    case 'DUP_CALLBACK': { const r = at(p.requests, step.a); if (!r) return false; await sim.duplicateCallback(r, 'FAILED'); return true; }
    case 'RETRY_FAIL': { const r = at(p.requests, step.a); if (!r) return false; await sim.retryFail(r); return true; }
    case 'MALFORMED': return applyMalformed(sim, step.a ?? 0);
    default: return false;
  }
}

/** Hostile / malformed action — MUST be rejected without corrupting state. */
async function applyMalformed(sim: Sim, kind: number): Promise<boolean> {
  const someFunded = sim.fundedAccounts()[0];
  const someUser = sim.userIds[0];
  try {
    switch (kind % 5) {
      case 0: // negative gross payout
        if (someFunded) await sim.requestPayoutFor(someFunded, -$(1000));
        break;
      case 1: // absurd gross payout
        if (someFunded) await sim.requestPayoutFor(someFunded, $(1_000_000_000));
        break;
      case 2: // payout for a non-existent account id
        await sim.requestPayoutFor({ id: '00000000-0000-0000-0000-000000000000', userId: someUser ?? '00000000-0000-0000-0000-000000000000', role: 'FUNDED', status: 'FUNDED' }, $(1000));
        break;
      case 3: // provision with a malformed profile version id (handled inside provisionEval catch)
        if (someUser) await sim.provisionEval(someUser, { enforceLimit: false, idemKey: 'x'.repeat(600) }).catch(() => undefined);
        break;
      case 4: // approve a non-existent payout request
        await sim.approveAndSubmit('00000000-0000-0000-0000-000000000000');
        break;
    }
  } catch {
    /* rejection is the expected outcome; the invariant check that follows proves no corruption */
  }
  return true;
}

export interface RunOptions {
  steps: number;
  /** Run the invariant oracle every N meaningful transitions (and always at the end). 1 = every step. */
  checkEvery?: number;
  /** Also run the money reconciliation in the oracle (slower). */
  reconcile?: boolean;
}

/** Run one seed to completion (online generation). Throws FuzzFailure on the first violation. */
export async function runSeed(db: Database, organizationId: string, evalKey: string, seed: number, opts: RunOptions): Promise<RunResult> {
  const sim = new Sim(db, organizationId, evalKey);
  const rng = new Prng(seed);
  const steps: Step[] = [];
  const checkEvery = opts.checkEvery ?? 1;
  let transitions = 0;
  let checks = 0;
  // Seed a couple of customers so early actions have targets.
  await sim.createCustomer('c0');
  await sim.createCustomer('c1');
  for (let i = 0; i < opts.steps; i += 1) {
    const step = chooseStep(sim, rng);
    steps.push(step);
    const meaningful = await applyStep(sim, step);
    if (!meaningful) continue;
    transitions += 1;
    if (transitions % checkEvery === 0) {
      checks += 1;
      const v = await sim.check({ reconcile: opts.reconcile });
      if (v.length > 0) throw new FuzzFailure(seed, i, v, steps.slice(0, i + 1), sim.history.slice(-8).map((h) => h.action).join('>'));
    }
  }
  // Final full check (with reconciliation) regardless of cadence.
  const v = await sim.check({ reconcile: true });
  if (v.length > 0) throw new FuzzFailure(seed, opts.steps, v, steps, 'final');
  const digest = await sim.digest();
  return { seed, transitions, checks, digest, steps };
}

/** Replay a concrete step list against a fresh Sim; throw FuzzFailure on the first violation. */
export async function replaySteps(db: Database, organizationId: string, evalKey: string, steps: Step[], opts: { reconcile?: boolean } = {}): Promise<string[]> {
  const sim = new Sim(db, organizationId, evalKey);
  await sim.createCustomer('c0');
  await sim.createCustomer('c1');
  for (let i = 0; i < steps.length; i += 1) {
    const meaningful = await applyStep(sim, steps[i]!);
    if (!meaningful) continue;
    const v = await sim.check({ reconcile: opts.reconcile });
    if (v.length > 0) throw new FuzzFailure(-1, i, v, steps.slice(0, i + 1), 'replay');
  }
  const v = await sim.check({ reconcile: true });
  if (v.length > 0) throw new FuzzFailure(-1, steps.length, v, steps, 'replay-final');
  return [];
}

/**
 * Remove-range delta-debugging: shrink a failing concrete step list to a smaller
 * one that still reproduces a violation. Each candidate is replayed against a fresh
 * DB (the caller supplies a per-attempt reset). Returns the smallest failing list found.
 */
export async function shrink(
  steps: Step[],
  reproduces: (candidate: Step[]) => Promise<boolean>,
): Promise<Step[]> {
  let current = steps;
  let granularity = Math.max(1, Math.floor(current.length / 2));
  while (granularity >= 1) {
    let reduced = false;
    for (let start = 0; start < current.length; start += granularity) {
      const candidate = [...current.slice(0, start), ...current.slice(start + granularity)];
      if (candidate.length === 0) continue;
      if (await reproduces(candidate)) {
        current = candidate;
        reduced = true;
        break;
      }
    }
    if (!reduced) granularity = Math.floor(granularity / 2);
  }
  return current;
}
