/**
 * Account provisioning.
 *
 * One function creates every account in the platform: the practice account a
 * new trader gets, the account an administrator hands out, and the account an
 * external firm's purchase flow will ask for later. The frontend never creates
 * account state; this is where accounts come from.
 *
 * It is idempotent by key, because a purchase webhook that fires twice must
 * not hand a customer two accounts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { assertNotEngaged } from './kill-switches.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  accountLifecycles,
  accounts,
  organizations,
  provisioningRequests,
  users,
} from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import { assertActiveSlotAvailable } from './account-limit.js';
import {
  ProfileError,
  resolveProfileByKey,
  resolveProfileVersion,
  type ResolvedProfile,
} from './profiles.js';

export class ProvisioningError extends Error {
  constructor(
    readonly code:
      | 'USER_NOT_FOUND'
      | 'ORGANIZATION_MISMATCH'
      | 'PROFILE_NOT_FOUND'
      | 'PROFILE_RETIRED'
      | 'INVALID_CONFIG'
      | 'IDEMPOTENCY_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export interface ProvisionInput {
  readonly organizationId: string;
  readonly userId: string;
  /** Either a product key (newest version) or an exact version to pin to. */
  readonly profileKey?: string;
  readonly profileVersionId?: string;
  readonly displayName?: string;
  /** Overrides the product's starting balance. Audited when it differs. */
  readonly startingBalanceMicros?: number;
  /** Per-account rule overrides, merged over the product's rules. */
  readonly ruleOverrides?: Record<string, unknown> | null;
  readonly executionOverrides?: Record<string, unknown> | null;
  readonly instrumentLimits?: Record<string, unknown> | null;
  /** Opaque. Stored, shown to admins, never interpreted. */
  readonly metadata?: Record<string, unknown> | null;
  /** Provision straight into ACTIVE. Otherwise the account starts PENDING. */
  readonly activate?: boolean;
  /**
   * Enforce the five-active-account invariant inside the creation transaction.
   * When set, the transaction takes a per-user advisory lock and refuses (throws
   * AccountLimitError) if the trader already holds five active (EVALUATION or
   * FUNDED_SIM, ACTIVE/PENDING, un-archived) accounts. Off by default so
   * practice/seed/admin-direct provisioning is unaffected; the commerce purchase
   * path opts in. A reused (idempotent) provision never re-checks: it returns
   * before the transaction, so re-driving an already-provisioned order is never
   * blocked.
   */
  readonly enforceActiveLimit?: boolean;
  readonly idempotencyKey?: string | null;
  readonly actor?: Actor;
}

export interface ProvisionResult {
  readonly accountId: string;
  readonly publicId: string;
  readonly profile: ResolvedProfile;
  /** True when an existing account was returned for a repeated key. */
  readonly reused: boolean;
}

function hashRequest(input: ProvisionInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        userId: input.userId,
        profileKey: input.profileKey ?? null,
        profileVersionId: input.profileVersionId ?? null,
        startingBalanceMicros: input.startingBalanceMicros ?? null,
        ruleOverrides: input.ruleOverrides ?? null,
        instrumentLimits: input.instrumentLimits ?? null,
      }),
    )
    .digest('hex');
}

/** The organisation everything belongs to until a second one is created. */
export async function defaultOrganizationId(db: Database): Promise<string> {
  const [row] = await db.select().from(organizations).where(eq(organizations.slug, 'atlas'));
  if (row) return row.id;
  const [created] = await db
    .insert(organizations)
    .values({ slug: 'atlas', name: 'Atlas Futures' })
    .returning();
  return created!.id;
}

export async function provisionAccount(
  db: Database,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  // Kill switch (HTF-10 enforcement): an owner can freeze all account
  // provisioning (both new evaluations and funding provisions).
  await assertNotEngaged(db, 'DISABLE_PROVISIONING');

  const [user] = await db.select().from(users).where(eq(users.id, input.userId));
  if (!user) throw new ProvisioningError('USER_NOT_FOUND', 'No such user.');
  // An account belongs to the organisation the user does. Provisioning across
  // a tenancy boundary is a bug in the caller, not a convenience.
  if (user.organizationId && user.organizationId !== input.organizationId) {
    throw new ProvisioningError(
      'ORGANIZATION_MISMATCH',
      'That user belongs to a different organisation.',
    );
  }

  const requestHash = hashRequest(input);

  if (input.idempotencyKey) {
    const [seen] = await db
      .select()
      .from(provisioningRequests)
      .where(
        and(
          eq(provisioningRequests.organizationId, input.organizationId),
          eq(provisioningRequests.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (seen) {
      // The same key with a different body is a mistake worth reporting, not a
      // second account and not a silent success.
      if (seen.requestHash !== requestHash) {
        throw new ProvisioningError(
          'IDEMPOTENCY_CONFLICT',
          'That idempotency key was used for a different request.',
        );
      }
      if (seen.accountId) {
        const [existing] = await db.select().from(accounts).where(eq(accounts.id, seen.accountId));
        if (existing) {
          const profile = existing.profileVersionId
            ? await resolveProfileVersion(db, existing.profileVersionId)
            : null;
          if (profile) {
            return {
              accountId: existing.id,
              publicId: existing.publicId,
              profile,
              reused: true,
            };
          }
        }
      }
    }
  }

  let profile: ResolvedProfile;
  try {
    profile = input.profileVersionId
      ? ((await resolveProfileVersion(db, input.profileVersionId)) ??
        (() => {
          throw new ProfileError('PROFILE_NOT_FOUND', 'No such product version.');
        })())
      : await resolveProfileByKey(db, input.organizationId, input.profileKey ?? '');
  } catch (err) {
    if (err instanceof ProfileError) {
      const code =
        err.code === 'PROFILE_RETIRED'
          ? 'PROFILE_RETIRED'
          : err.code === 'INVALID_CONFIG'
            ? 'INVALID_CONFIG'
            : 'PROFILE_NOT_FOUND';
      throw new ProvisioningError(code, err.message);
    }
    throw err;
  }

  const rules = profile.config.rules;
  const startingBalance =
    input.startingBalanceMicros ??
    profile.config.display.startingBalanceMicros ??
    rules.accountSizeMicros;

  const created = await db.transaction(async (tx) => {
    // The five-active-account invariant. Taken here, inside the creation
    // transaction, so the per-user lock is held across the count and the insert:
    // two concurrent provisions for the same trader serialise, and the second
    // reads the first's committed account and refuses. Throws AccountLimitError.
    if (input.enforceActiveLimit) {
      await assertActiveSlotAvailable(tx as unknown as Database, input.userId);
    }
    const [account] = await tx
      .insert(accounts)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        profileVersionId: profile.versionId,
        name: input.displayName?.trim() || profile.profileName,
        accountType: profile.accountType,
        status: input.activate === false ? 'PENDING' : 'ACTIVE',
        // An account that has not been activated is on an operator hold, so
        // the rule engine cannot quietly activate it on the next mark.
        adminHold: input.activate === false ? 'PENDING' : null,
        activatedAt: input.activate === false ? null : new Date(),
        startingBalanceMicros: startingBalance,
        balanceMicros: startingBalance,
        highWaterMarkMicros: startingBalance,
        drawdownFloorMicros: startingBalance - rules.maxLossMicros,
        dayStartBalanceMicros: startingBalance,
        dayStartEquityMicros: startingBalance,
        ruleOverrides: (input.ruleOverrides ?? null) as never,
        simulationEnvironment: (input.executionOverrides ??
          profile.config.execution ??
          null) as never,
        instrumentLimits: (input.instrumentLimits ?? null) as never,
        externalMetadata: (input.metadata ?? null) as never,
      })
      .returning();

    const [lifecycle] = await tx
      .insert(accountLifecycles)
      .values({
        accountId: account!.id,
        seq: 1,
        profileVersionId: profile.versionId,
        startingBalanceMicros: startingBalance,
      })
      .returning();

    await tx
      .update(accounts)
      .set({ currentLifecycleId: lifecycle!.id })
      .where(eq(accounts.id, account!.id));

    if (input.idempotencyKey) {
      await tx
        .insert(provisioningRequests)
        .values({
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          accountId: account!.id,
        })
        .onConflictDoNothing();
    }

    return account!;
  });

  await recordAudit(db, {
    organizationId: input.organizationId,
    actor,
    subjectType: 'ACCOUNT',
    subjectId: created.id,
    accountId: created.id,
    userId: input.userId,
    action: 'account.created',
    newState: {
      publicId: created.publicId,
      status: created.status,
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      startingBalanceMicros: startingBalance,
    },
    context: {
      overrodeStartingBalance:
        input.startingBalanceMicros !== undefined &&
        input.startingBalanceMicros !== profile.config.display.startingBalanceMicros,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  await events.publish(db, {
    type: 'account.created',
    organizationId: input.organizationId,
    accountId: created.id,
    userId: input.userId,
    payload: {
      publicId: created.publicId,
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      startingBalanceMicros: startingBalance,
      status: created.status,
    },
  });

  if (created.status === 'ACTIVE') {
    await events.publish(db, {
      type: 'account.activated',
      organizationId: input.organizationId,
      accountId: created.id,
      userId: input.userId,
      payload: { publicId: created.publicId },
    });
  }

  return {
    accountId: created.id,
    publicId: created.publicId,
    profile,
    reused: false,
  };
}

/**
 * The practice account every new trader starts with.
 *
 * Provisioned through the same path as any other account - it is not a
 * frontend convenience and not a seed-script special case. Idempotent by a key
 * derived from the user, so a retried registration cannot produce two.
 */
export async function ensurePracticeAccount(
  db: Database,
  userId: string,
  organizationId?: string,
): Promise<ProvisionResult | null> {
  const orgId = organizationId ?? (await defaultOrganizationId(db));
  try {
    return await provisionAccount(db, {
      organizationId: orgId,
      userId,
      profileKey: 'practice-150k',
      idempotencyKey: `practice:${userId}`,
      actor: { type: 'SYSTEM', label: 'registration' },
    });
  } catch (err) {
    // A deployment without the practice product must still be able to register
    // a user; the account can be provisioned later by an administrator.
    if (err instanceof ProvisioningError && err.code === 'PROFILE_NOT_FOUND') return null;
    throw err;
  }
}

/** A key that makes a caller's retry idempotent when they supplied none. */
export function provisioningKey(): string {
  return randomUUID();
}
