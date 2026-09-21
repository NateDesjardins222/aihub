/**
 * Automatic certification: the seam between the reversible rule engine and the
 * one-way commercial qualification.
 *
 * The engine's PASSED is a per-mark verdict - give the profit back and it
 * reverts to ACTIVE. That is correct for the engine and wrong for a sale: a
 * prop firm does not un-pass a trader who hit the target. So the moment the
 * engine publishes `account.passed` for an evaluation, this certifies it -
 * server-authoritative, idempotent, and freezing the account so the verdict
 * cannot reverse. Nothing in the engine knows this exists; it subscribes.
 *
 * `account.passed` is written to `domain_events` before any subscriber runs, so
 * a certification lost to a crash is recoverable. `certifyPassedEvaluations`
 * is the recovery: a startup sweep that certifies any evaluation the engine
 * left PASSED without a qualification. Between the two, a pass always becomes a
 * qualification, exactly once.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accountQualifications, accounts } from '../db/schema.js';
import { events } from './events.js';
import { certifyEvaluation } from './commerce.js';

/**
 * Subscribe certification to the engine's pass verdict. Returns an unsubscribe
 * for shutdown. A failure here never fails the trade that caused it - the
 * subscriber is a bystander, and the startup sweep is the safety net.
 */
export function registerAutoCertification(db: Database): () => void {
  return events.subscribe(async (event) => {
    if (event.type !== 'account.passed' || !event.accountId) return;
    await certifyEvaluation(db, event.accountId).catch(() => undefined);
  });
}

/**
 * Certify every evaluation the engine has left PASSED with no qualification for
 * its current life. Idempotent and safe to run on every boot: an account
 * already certified is skipped by certifyEvaluation's own guard.
 */
export async function certifyPassedEvaluations(db: Database): Promise<number> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .leftJoin(
      accountQualifications,
      and(
        eq(accountQualifications.accountId, accounts.id),
        eq(accountQualifications.lifecycleId, accounts.currentLifecycleId),
      ),
    )
    .where(
      and(
        eq(accounts.accountType, 'EVALUATION'),
        eq(accounts.status, 'PASSED'),
        isNull(accountQualifications.id),
      ),
    );

  let certified = 0;
  for (const row of rows) {
    const qual = await certifyEvaluation(db, row.id).catch(() => null);
    if (qual) certified += 1;
  }
  return certified;
}
