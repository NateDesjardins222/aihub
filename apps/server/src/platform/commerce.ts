/**
 * The commercial account lifecycle (Commercial Account Lifecycle V1).
 *
 * Provider-independent, and the authoritative layer a future payment provider
 * merely triggers:
 *
 *   completeCommercialOrder → grantEntitlement → provisionFromEntitlement
 *   (evaluation) → [trader trades, the rule engine decides] → certifyEvaluation
 *   (server-authoritative pass, immutable evidence) → requestFunding →
 *   approveFunding → a FUNDED_SIM account, linked back to the evaluation.
 *
 * No money moves here. `amountMicros` is informational. An admin grant and a
 * Stripe webhook enter through the same door (`acquireEvaluation`), differing
 * only in `source`. Every step is idempotent so a retry, a double-click, a
 * concurrent caller or a restart produces exactly one of each account.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accountLifecycles,
  accountProfileVersions,
  accountProfiles,
  accountQualifications,
  accounts,
  commercialOrders,
  entitlements,
} from '../db/schema.js';
import { statusFromState } from '@atlas/core';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { enqueueOutbox } from './outbox.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { provisionAccount } from './provisioning.js';
import { resolveProfileByKey, resolveProfileVersion, type ProfileConfig } from './profiles.js';
import {
  loadAccountAndTemplate,
  ruleConfigFor,
  ruleStateFor,
  historyFor,
} from '../trading/account-rules.js';
import { accountAdvisoryLockSql } from '../trading/account-lock.js';

export class CommerceError extends Error {
  constructor(
    readonly code:
      | 'PRODUCT_NOT_FOUND'
      | 'ENTITLEMENT_NOT_FOUND'
      | 'ENTITLEMENT_CONSUMED'
      | 'ACCOUNT_NOT_FOUND'
      | 'NOT_QUALIFIED'
      | 'QUALIFICATION_NOT_FOUND'
      | 'NO_FUNDED_DESTINATION'
      | 'INVALID_FUNDING_STATE'
      | 'ORGANIZATION_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'CommerceError';
  }
}

type CommercialOrderRow = typeof commercialOrders.$inferSelect;
type EntitlementRow = typeof entitlements.$inferSelect;
type QualificationRow = typeof accountQualifications.$inferSelect;

// ---------------------------------------------------------------------------
// Commercial order + entitlement
// ---------------------------------------------------------------------------

export interface CompleteOrderInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly productVersionId: string;
  readonly source: string; // ADMIN_GRANT | PURCHASE | ...
  readonly externalProvider?: string | null;
  readonly externalReference?: string | null;
  readonly amountMicros?: number | null;
  readonly currency?: string | null;
  /** Dedupe: a webhook that fires twice completes one order. */
  readonly idempotencyKey?: string | null;
  readonly actor?: Actor;
}

/**
 * Record a COMPLETED commercial order. Idempotent by (org, idempotencyKey): a
 * repeated completion returns the existing order rather than creating a second.
 * This is the boundary a payment webhook calls after it has verified a payment.
 */
export async function completeCommercialOrder(
  db: Database,
  input: CompleteOrderInput,
): Promise<CommercialOrderRow> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(commercialOrders)
      .where(
        and(
          eq(commercialOrders.organizationId, input.organizationId),
          eq(commercialOrders.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) return existing;
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [order] = await tx
      .insert(commercialOrders)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        productVersionId: input.productVersionId,
        source: input.source,
        externalProvider: input.externalProvider ?? null,
        externalReference: input.externalReference ?? null,
        status: 'COMPLETED',
        amountMicros: input.amountMicros ?? null,
        currency: input.currency ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        completedAt: new Date(),
      })
      .onConflictDoNothing({
        target: [commercialOrders.organizationId, commercialOrders.idempotencyKey],
      })
      .returning();
    if (!order) {
      // A concurrent completion won the unique index; return the winner.
      const [winner] = await tx
        .select()
        .from(commercialOrders)
        .where(
          and(
            eq(commercialOrders.organizationId, input.organizationId),
            eq(commercialOrders.idempotencyKey, input.idempotencyKey ?? ''),
          ),
        );
      return winner!;
    }
    await recordAudit(scoped, {
      organizationId: input.organizationId,
      actor,
      subjectType: 'USER',
      subjectId: input.userId,
      userId: input.userId,
      action: 'commercial_order.completed',
      newState: { orderId: order.id, source: input.source, productVersionId: input.productVersionId },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'commercial_order.completed',
      organizationId: input.organizationId,
      userId: input.userId,
      payload: { orderId: order.id, source: input.source },
    });
    return order;
  });
}

/**
 * Grant an entitlement from a completed order (or a direct admin grant with a
 * null order). Idempotent by (commercialOrderId, kind): one order grants one
 * entitlement of a kind.
 */
export async function grantEntitlement(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    commercialOrderId: string | null;
    productVersionId: string;
    kind: 'EVALUATION' | 'RESET';
    source: string;
    actor?: Actor;
  },
): Promise<EntitlementRow> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  if (input.commercialOrderId) {
    const [existing] = await db
      .select()
      .from(entitlements)
      .where(
        and(
          eq(entitlements.commercialOrderId, input.commercialOrderId),
          eq(entitlements.kind, input.kind),
        ),
      );
    if (existing) return existing;
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [ent] = await tx
      .insert(entitlements)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        commercialOrderId: input.commercialOrderId,
        productVersionId: input.productVersionId,
        kind: input.kind,
        source: input.source,
        status: 'GRANTED',
      })
      .onConflictDoNothing({ target: [entitlements.commercialOrderId, entitlements.kind] })
      .returning();
    if (!ent) {
      const [winner] = await tx
        .select()
        .from(entitlements)
        .where(
          and(
            eq(entitlements.commercialOrderId, input.commercialOrderId!),
            eq(entitlements.kind, input.kind),
          ),
        );
      return winner!;
    }
    await recordAudit(scoped, {
      organizationId: input.organizationId,
      actor,
      subjectType: 'USER',
      subjectId: input.userId,
      userId: input.userId,
      action: 'entitlement.granted',
      newState: { entitlementId: ent.id, kind: input.kind, source: input.source },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'entitlement.granted',
      organizationId: input.organizationId,
      userId: input.userId,
      payload: { entitlementId: ent.id, kind: input.kind },
    });
    return ent;
  });
}

/**
 * Consume an entitlement to provision exactly one account. Idempotent: if the
 * entitlement was already consumed, the same account is returned. Provisioning's
 * own idempotency key (`ent:<id>`) is the second guard against a duplicate under
 * concurrency or restart. For an evaluation whose product names a funded
 * destination, the funded product's current version is pinned onto the account
 * now, so a later change to the funded product cannot alter this sale.
 */
export async function provisionFromEntitlement(
  db: Database,
  entitlementId: string,
  opts: { actor?: Actor; activate?: boolean } = {},
): Promise<{ accountId: string; reused: boolean }> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const [ent] = await db.select().from(entitlements).where(eq(entitlements.id, entitlementId));
  if (!ent) throw new CommerceError('ENTITLEMENT_NOT_FOUND', 'No such entitlement.');
  if (ent.consumedByAccountId) {
    return { accountId: ent.consumedByAccountId, reused: true };
  }
  if (ent.status === 'REVOKED') {
    throw new CommerceError('ENTITLEMENT_CONSUMED', 'That entitlement has been revoked.');
  }

  const product = await resolveProfileVersion(db, ent.productVersionId);
  if (!product) throw new CommerceError('PRODUCT_NOT_FOUND', 'The product version no longer exists.');

  const result = await provisionAccount(db, {
    organizationId: ent.organizationId,
    userId: ent.userId,
    profileVersionId: ent.productVersionId,
    activate: opts.activate ?? true,
    idempotencyKey: `ent:${ent.id}`,
    actor,
    metadata: { entitlementId: ent.id, commercialOrderId: ent.commercialOrderId },
  });

  // Pin the funded destination version at acquisition (Phase 50), and mark the
  // entitlement consumed, in one commit.
  const fundedVersionId = await resolveFundedDestinationVersionId(db, ent.organizationId, product.config);
  await db.transaction(async (tx) => {
    if (fundedVersionId) {
      await tx
        .update(accounts)
        .set({ fundedProfileVersionId: fundedVersionId })
        .where(eq(accounts.id, result.accountId));
    }
    await tx
      .update(entitlements)
      .set({ status: 'CONSUMED', consumedByAccountId: result.accountId, consumedAt: new Date() })
      .where(and(eq(entitlements.id, ent.id), eq(entitlements.status, 'GRANTED')));
    await events.publish(tx as unknown as Database, {
      type: 'entitlement.consumed',
      organizationId: ent.organizationId,
      userId: ent.userId,
      accountId: result.accountId,
      payload: { entitlementId: ent.id },
    });
  });

  return { accountId: result.accountId, reused: result.reused };
}

/** Resolve an evaluation product's funded destination to its current version id. */
async function resolveFundedDestinationVersionId(
  db: Database,
  organizationId: string,
  config: ProfileConfig,
): Promise<string | null> {
  const key = config.fundedDestinationKey;
  if (!key) return null;
  try {
    const funded = await resolveProfileByKey(db, organizationId, key);
    return funded.versionId;
  } catch {
    // A missing/retired funded product is not fatal at provision time; funding
    // approval will surface NO_FUNDED_DESTINATION if it never becomes resolvable.
    return null;
  }
}

/**
 * The whole acquisition, in one call: complete an order, grant an entitlement,
 * provision an evaluation. This is the single entry an admin grant and a future
 * payment webhook both use. Fully idempotent through its parts.
 */
export async function acquireEvaluation(
  db: Database,
  input: CompleteOrderInput & { activate?: boolean },
): Promise<{ orderId: string; entitlementId: string; accountId: string; reused: boolean }> {
  const order = await completeCommercialOrder(db, input);
  const ent = await grantEntitlement(db, {
    organizationId: input.organizationId,
    userId: input.userId,
    commercialOrderId: order.id,
    productVersionId: input.productVersionId,
    kind: 'EVALUATION',
    source: input.source,
    actor: input.actor,
  });
  const provisioned = await provisionFromEntitlement(db, ent.id, {
    actor: input.actor,
    activate: input.activate,
  });
  return {
    orderId: order.id,
    entitlementId: ent.id,
    accountId: provisioned.accountId,
    reused: provisioned.reused,
  };
}

// ---------------------------------------------------------------------------
// Qualification (server-authoritative pass)
// ---------------------------------------------------------------------------

const CERTIFIABLE_FROM = ['ACTIVE', 'GOAL_REACHED', 'PASSED'];

export interface QualificationEvidence {
  readonly requirements: Array<{
    key: string;
    label: string;
    required: number;
    actual: number;
    unit: string;
    met: boolean;
  }>;
  readonly drawdownBreached: boolean;
  readonly balanceMicros: number;
  readonly startingBalanceMicros: number;
}

/**
 * Certify an evaluation as PASSED, if and only if the authoritative rule state
 * says every requirement is met and nothing is breached or held. One-way and
 * idempotent: the immutable qualification row is unique per (account, lifecycle),
 * and the account is frozen (status PASSED + a QUALIFIED hold) so the reversible
 * rule engine cannot un-pass it and the order gate rejects new orders
 * (`ACCOUNT_PASSED`). Returns the qualification, or null when not (yet) eligible.
 */
export async function certifyEvaluation(
  db: Database,
  accountId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<QualificationRow | null> {
  const loaded = await loadAccountAndTemplate(db, accountId);
  if (!loaded) throw new CommerceError('ACCOUNT_NOT_FOUND', 'No such account.');
  const { account, template } = loaded;

  // Only an evaluation qualifies for funding. A practice account has no target
  // and a funded account's target belongs to a payout, not another funding.
  if (account.accountType !== 'EVALUATION') return null;

  // Already certified for this life? Return it (idempotent).
  const existing = account.currentLifecycleId
    ? await db
        .select()
        .from(accountQualifications)
        .where(
          and(
            eq(accountQualifications.accountId, accountId),
            eq(accountQualifications.lifecycleId, account.currentLifecycleId),
          ),
        )
        .then((r) => r[0])
    : undefined;
  if (existing) return existing;

  // Not certifiable from a failed/held/pending account.
  if (!CERTIFIABLE_FROM.includes(account.status)) return null;

  const config = ruleConfigFor(account, template);
  const state = ruleStateFor(account);
  const status = statusFromState(config, state, historyFor(account));
  const allMet = status.requirements.length > 0 && status.requirements.every((r) => r.met);
  const targetMet = config.profitTargetMicros > 0;
  if (!allMet || !targetMet) return null; // not yet qualified

  const evidence: QualificationEvidence = {
    requirements: status.requirements.map((r) => ({
      key: r.key,
      label: r.label,
      required: r.required,
      actual: r.current,
      unit: r.unit,
      met: r.met,
    })),
    drawdownBreached: false,
    balanceMicros: account.balanceMicros,
    startingBalanceMicros: account.startingBalanceMicros,
  };

  return db.transaction(async (tx) => {
    await tx.execute(accountAdvisoryLockSql(accountId));
    const [before] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for('update');
    if (!before) throw new CommerceError('ACCOUNT_NOT_FOUND', 'No such account.');
    // Re-check under the lock: a breach may have committed first (pass/fail race).
    if (!CERTIFIABLE_FROM.includes(before.status)) return null;

    const scoped = tx as unknown as Database;
    // Freeze: PASSED + a QUALIFIED hold so persistRuleState cannot overwrite the
    // status, and the order gate rejects with ACCOUNT_PASSED.
    await tx
      .update(accounts)
      .set({ status: 'PASSED', ruleStatus: 'PASSED', adminHold: 'QUALIFIED', updatedAt: new Date() })
      .where(eq(accounts.id, accountId));

    // Close the current life as PASSED.
    if (before.currentLifecycleId) {
      await tx
        .update(accountLifecycles)
        .set({
          endedAt: new Date(),
          endReason: 'PASSED',
          finalBalanceMicros: before.balanceMicros,
          finalStatus: 'PASSED',
        })
        .where(
          and(
            eq(accountLifecycles.id, before.currentLifecycleId),
            eq(accountLifecycles.accountId, accountId),
          ),
        );
    }

    const [qual] = await tx
      .insert(accountQualifications)
      .values({
        organizationId: before.organizationId!,
        accountId,
        lifecycleId: before.currentLifecycleId,
        productVersionId: before.profileVersionId,
        evidence: evidence as unknown as object,
        balanceMicros: before.balanceMicros,
        fundingState: 'ELIGIBLE',
      })
      .onConflictDoNothing({
        target: [accountQualifications.accountId, accountQualifications.lifecycleId],
      })
      .returning();
    if (!qual) {
      // A concurrent certify won; return its row.
      const [winner] = await tx
        .select()
        .from(accountQualifications)
        .where(
          and(
            eq(accountQualifications.accountId, accountId),
            eq(accountQualifications.lifecycleId, before.currentLifecycleId!),
          ),
        );
      return winner!;
    }

    await recordAudit(scoped, {
      organizationId: before.organizationId,
      actor,
      subjectType: 'ACCOUNT',
      subjectId: accountId,
      accountId,
      userId: before.userId,
      action: 'evaluation.qualified',
      prevState: { status: before.status },
      newState: { status: 'PASSED', qualificationId: qual.id },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'evaluation.qualified',
      organizationId: before.organizationId,
      accountId,
      userId: before.userId,
      payload: { qualificationId: qual.id, publicId: before.publicId },
    });
    await enqueueOutbox(scoped, { aggregateId: accountId, type: 'account.changed', payload: { reason: 'evaluation.qualified' } });
    return qual;
  });
}

// ---------------------------------------------------------------------------
// Funding transition
// ---------------------------------------------------------------------------

/**
 * Approve funding for a qualification and provision exactly one FUNDED_SIM
 * account, linked back to the evaluation. Idempotent: if the qualification
 * already produced a funded account, that account is returned. Provisioning's
 * own key (`fund:<qualificationId>`) is the second guard, so a double-click,
 * concurrent owners or a retry never create two funded accounts. The funded
 * account is pinned to the version recorded on the evaluation at acquisition.
 */
export async function approveFunding(
  db: Database,
  qualificationId: string,
  opts: { actor?: Actor; activate?: boolean } = {},
): Promise<{ fundedAccountId: string; reused: boolean }> {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const [qual] = await db
    .select()
    .from(accountQualifications)
    .where(eq(accountQualifications.id, qualificationId));
  if (!qual) throw new CommerceError('QUALIFICATION_NOT_FOUND', 'No such qualification.');
  if (qual.fundedAccountId) return { fundedAccountId: qual.fundedAccountId, reused: true };
  if (qual.fundingState === 'DECLINED') {
    throw new CommerceError('INVALID_FUNDING_STATE', 'This qualification was declined.');
  }

  const [evalAccount] = await db.select().from(accounts).where(eq(accounts.id, qual.accountId));
  if (!evalAccount) throw new CommerceError('ACCOUNT_NOT_FOUND', 'Evaluation account gone.');
  if (!evalAccount.fundedProfileVersionId) {
    throw new CommerceError('NO_FUNDED_DESTINATION', 'This product has no funded destination.');
  }

  // Provision the funded account (idempotent by qualification id).
  const funded = await provisionAccount(db, {
    organizationId: qual.organizationId,
    userId: evalAccount.userId,
    profileVersionId: evalAccount.fundedProfileVersionId,
    activate: opts.activate ?? true,
    idempotencyKey: `fund:${qual.id}`,
    actor,
    metadata: { fundedFromQualificationId: qual.id, fundedFromAccountId: qual.accountId },
  });

  await db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    // Link the funded account back to the evaluation, and record approval.
    await tx
      .update(accounts)
      .set({ sourceQualificationId: qual.id, sourceAccountId: qual.accountId })
      .where(eq(accounts.id, funded.accountId));
    // Guard the funding-state flip so two approvals cannot both write FUNDED.
    await tx
      .update(accountQualifications)
      .set({
        fundingState: 'FUNDED',
        fundedAccountId: funded.accountId,
        approvedByUserId: actor.type === 'USER' ? actor.userId : null,
        approvedAt: new Date(),
      })
      .where(
        and(eq(accountQualifications.id, qual.id), eq(accountQualifications.fundingState, qual.fundingState)),
      );
    await recordAudit(scoped, {
      organizationId: qual.organizationId,
      actor,
      subjectType: 'ACCOUNT',
      subjectId: qual.accountId,
      accountId: qual.accountId,
      userId: evalAccount.userId,
      action: 'funding.approved',
      newState: { fundedAccountId: funded.accountId, qualificationId: qual.id },
      reason: null,
    });
    await events.publish(scoped, {
      type: 'funding.approved',
      organizationId: qual.organizationId,
      accountId: qual.accountId,
      userId: evalAccount.userId,
      payload: { qualificationId: qual.id, fundedAccountId: funded.accountId },
    });
    await events.publish(scoped, {
      type: 'account.funded',
      organizationId: qual.organizationId,
      accountId: funded.accountId,
      userId: evalAccount.userId,
      payload: { fundedFromAccountId: qual.accountId, qualificationId: qual.id },
    });
  });

  return { fundedAccountId: funded.accountId, reused: funded.reused };
}

/** Decline funding for a qualification, with a required reason. Idempotent-ish. */
export async function declineFunding(
  db: Database,
  qualificationId: string,
  reason: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<QualificationRow> {
  const [qual] = await db
    .select()
    .from(accountQualifications)
    .where(eq(accountQualifications.id, qualificationId));
  if (!qual) throw new CommerceError('QUALIFICATION_NOT_FOUND', 'No such qualification.');
  if (qual.fundingState === 'FUNDED') {
    throw new CommerceError('INVALID_FUNDING_STATE', 'This qualification is already funded.');
  }
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [after] = await tx
      .update(accountQualifications)
      .set({ fundingState: 'DECLINED', declineReason: reason, approvedByUserId: actor.type === 'USER' ? actor.userId : null, approvedAt: new Date() })
      .where(eq(accountQualifications.id, qual.id))
      .returning();
    await recordAudit(scoped, {
      organizationId: qual.organizationId,
      actor,
      subjectType: 'ACCOUNT',
      subjectId: qual.accountId,
      accountId: qual.accountId,
      action: 'funding.declined',
      newState: { qualificationId: qual.id },
      reason,
    });
    await events.publish(scoped, {
      type: 'funding.declined',
      organizationId: qual.organizationId,
      accountId: qual.accountId,
      payload: { qualificationId: qual.id, reason },
    });
    return after!;
  });
}
