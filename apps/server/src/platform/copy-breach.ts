/**
 * Copy-trading breach reaction (docs/copy-trading-failure-modes-v1.md; §leader
 * breach, §follower breach).
 *
 * A leader account that FAILS or is LOCKED can no longer lead: the group must
 * stop copying immediately and wait for the owner to designate a new, eligible
 * leader. There is NEVER a silent promotion of a follower — the group is paused
 * and the choice is left to the owner.
 *
 * This is a bystander subscriber on the domain-event bus, exactly like
 * engine-audit and commerce-certify: the execution engine and the account
 * lifecycle know nothing about copy trading. When they announce `account.failed`
 * or `account.locked`, this turns that into a group pause. A pause flattens
 * nothing; the follower and leader positions are left as they are, and the owner
 * flattens or resyncs deliberately.
 *
 * A FOLLOWER that breaches needs no reaction here: its own risk pipeline rejects
 * its future child orders, so it is isolated automatically while the rest of the
 * group keeps trading — the divergence view shows the gap, and the owner may
 * disable or resync it. Reacting to a follower breach by mutating group state
 * would be the kind of silent change this milestone forbids.
 */
import type { Database } from '../db/client.js';
import { events, type DomainEvent } from './events.js';
import { systemPauseGroupsLedBy } from './copy-groups.js';

/** Events that mean an account can no longer lead a copy group. */
const LEADER_DISABLING = new Set(['account.failed', 'account.locked']);

/**
 * Attach the copy-breach reaction to the event bus. Returns the unsubscribe
 * function so a test or shutdown can detach it. Failures are swallowed: a copy
 * pause must never fail the account action that caused the breach.
 */
export function attachCopyBreachHandler(db: Database): () => void {
  const handler = async (event: DomainEvent): Promise<void> => {
    if (!LEADER_DISABLING.has(event.type) || !event.accountId) return;
    const reason = `Leader ${event.type === 'account.failed' ? 'failed' : 'locked'} — group paused, choose a new leader`;
    // The bus awaits subscribers and swallows their errors (a broken bystander
    // never fails the account action), so pausing here neither blocks trading
    // meaningfully nor risks it — the pause is a single small update.
    await systemPauseGroupsLedBy(db, event.accountId, reason);
  };
  return events.subscribe(handler);
}
