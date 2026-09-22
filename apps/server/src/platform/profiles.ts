/**
 * Products, and the versions that hold their terms.
 *
 * Atlas does not know what any firm's product means. It receives a
 * configuration and enforces it. A profile is the NAME a firm sells; a version
 * is the terms that name had on a given day. An account is pinned to a
 * version, so editing a product never rewrites the rules of an account already
 * trading it - published versions are immutable at the database level.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { RuleConfig } from '@atlas/core';
import type { Database } from '../db/client.js';
import { accountProfileDrafts, accountProfileVersions, accountProfiles } from '../db/schema.js';
import { normalizeRuleConfig } from '../trading/account-rules.js';

/**
 * The rule half of a product's configuration.
 *
 * Exactly the shape the pure rule engine consumes, so a firm's product is a
 * row of numbers and nothing branches on which firm it came from.
 */
export const ruleConfigSchema = z.object({
  accountSizeMicros: z.number().int().nonnegative(),
  profitTargetMicros: z.number().int().nonnegative(),
  maxLossMicros: z.number().int().nonnegative(),
  drawdownType: z.enum(['STATIC', 'INTRADAY_TRAILING', 'EOD_TRAILING']),
  trailingLockAtMicros: z.number().int().nullable(),
  dailyLossLimitMicros: z.number().int().positive().nullable(),
  dailyLossPolicy: z.enum(['LOCK_DAY', 'FAIL']),
  consistencyFormula: z.enum(['BEST_DAY_OVER_TOTAL', 'BEST_DAY_OVER_TARGET']),
  consistencyThreshold: z.number().min(0.01).max(1).nullable(),
  minTradingDays: z.number().int().nonnegative(),
  minWinningDays: z.number().int().nonnegative(),
  maxTradingDays: z.number().int().positive().nullable(),
  minDailyPnlToCountMicros: z.number().int(),
  minWinningDayPnlMicros: z.number().int(),
  maxContracts: z.number().int().positive(),
  microsCountAsFraction: z.boolean(),
  flattenOnBreach: z.boolean(),
});

/** What may be traded, and how much of it. */
export const instrumentPolicySchema = z.object({
  /** Roots the account may trade. Null means every instrument Atlas carries. */
  allowed: z.array(z.string().min(1).max(12)).nullable().default(null),
  maxContracts: z.number().int().positive().nullable().default(null),
  /** Per-root caps, which never raise the account-wide cap, only lower it. */
  perInstrument: z.record(z.string().max(12), z.number().int().positive()).default({}),
});

export const profileConfigSchema = z.object({
  rules: ruleConfigSchema,
  /** Fill model, latency, slippage, fees. Validated by the engine's own schema. */
  execution: z.record(z.string(), z.unknown()).nullable().default(null),
  instruments: instrumentPolicySchema.default({ allowed: null, maxContracts: null, perInstrument: {} }),
  display: z
    .object({ startingBalanceMicros: z.number().int().positive().optional() })
    .default({}),
  /** Opaque to the engine; carried so a firm's payout terms travel with the product. */
  payoutRules: z.unknown().nullable().default(null),
  /**
   * For an EVALUATION product: the machine key of the funded product a pass
   * qualifies for. Resolved to its then-current version and pinned onto the
   * evaluation account at provision time, so a later change to the funded
   * product never alters an already-sold evaluation's destination. Null when a
   * pass produces no funded account (or for a funded product itself).
   */
  fundedDestinationKey: z.string().min(1).max(64).nullable().default(null),
  /**
   * The Whop plan/product id this product is sold as. Used only to build a
   * checkout link; the payment itself happens entirely on Whop. Null when the
   * product is not sold through Whop (e.g. a practice or funded product, or one
   * granted only by an admin). Opaque here: Atlas never charges it.
   */
  whopPlanId: z.string().min(1).max(120).nullable().default(null),
});

export type ProfileConfig = z.infer<typeof profileConfigSchema>;
export type InstrumentPolicy = z.infer<typeof instrumentPolicySchema>;

export class ProfileError extends Error {
  constructor(
    readonly code: 'PROFILE_NOT_FOUND' | 'PROFILE_RETIRED' | 'NO_VERSION' | 'INVALID_CONFIG',
    message: string,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface ResolvedProfile {
  readonly profileId: string;
  readonly profileKey: string;
  readonly profileName: string;
  readonly accountType: string;
  readonly versionId: string;
  readonly version: number;
  readonly config: ProfileConfig;
}

function parseConfig(raw: unknown): ProfileConfig {
  const parsed = profileConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfileError('INVALID_CONFIG', 'The product configuration is not valid.');
  }
  // The same normalisation an account's own overrides go through, so a product
  // cannot be published with terms the engine would have to guess at.
  return { ...parsed.data, rules: normalizeRuleConfig(parsed.data.rules as RuleConfig) };
}

/** The newest version of a product, by its machine key. */
export async function resolveProfileByKey(
  db: Database,
  organizationId: string,
  key: string,
): Promise<ResolvedProfile> {
  const [profile] = await db
    .select()
    .from(accountProfiles)
    .where(and(eq(accountProfiles.organizationId, organizationId), eq(accountProfiles.key, key)));
  if (!profile) throw new ProfileError('PROFILE_NOT_FOUND', `No product named ${key}.`);
  if (profile.status !== 'ACTIVE') {
    throw new ProfileError('PROFILE_RETIRED', `${profile.name} is retired and cannot be sold.`);
  }
  const [version] = await db
    .select()
    .from(accountProfileVersions)
    .where(eq(accountProfileVersions.profileId, profile.id))
    .orderBy(desc(accountProfileVersions.version))
    .limit(1);
  if (!version) throw new ProfileError('NO_VERSION', `${profile.name} has no published version.`);

  return {
    profileId: profile.id,
    profileKey: profile.key,
    profileName: profile.name,
    accountType: profile.accountType,
    versionId: version.id,
    version: version.version,
    config: parseConfig(version.config),
  };
}

/** A specific version, which is what an account is pinned to. */
export async function resolveProfileVersion(
  db: Database,
  versionId: string,
): Promise<ResolvedProfile | null> {
  const [row] = await db
    .select({ version: accountProfileVersions, profile: accountProfiles })
    .from(accountProfileVersions)
    .innerJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
    .where(eq(accountProfileVersions.id, versionId));
  if (!row) return null;
  return {
    profileId: row.profile.id,
    profileKey: row.profile.key,
    profileName: row.profile.name,
    accountType: row.profile.accountType,
    versionId: row.version.id,
    version: row.version.version,
    config: parseConfig(row.version.config),
  };
}

export interface PublishInput {
  readonly organizationId: string;
  readonly key: string;
  readonly name: string;
  readonly accountType: string;
  readonly description?: string | null;
  readonly config: unknown;
  readonly notes?: string | null;
  readonly createdByUserId?: string | null;
}

/**
 * Publish a product, or a new version of one.
 *
 * Never an update: version N+1 is written and accounts pinned to version N
 * keep the terms they were sold. That is the rule the whole product system
 * exists to enforce, and the database enforces it too.
 */
export async function publishProfileVersion(
  db: Database,
  input: PublishInput,
): Promise<ResolvedProfile> {
  const config = parseConfig(input.config);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(accountProfiles)
      .where(
        and(
          eq(accountProfiles.organizationId, input.organizationId),
          eq(accountProfiles.key, input.key),
        ),
      );

    const profile =
      existing ??
      (
        await tx
          .insert(accountProfiles)
          .values({
            organizationId: input.organizationId,
            key: input.key,
            name: input.name,
            accountType: input.accountType,
            description: input.description ?? null,
          })
          .returning()
      )[0]!;

    if (existing) {
      await tx
        .update(accountProfiles)
        .set({
          name: input.name,
          accountType: input.accountType,
          description: input.description ?? existing.description,
          updatedAt: new Date(),
        })
        .where(eq(accountProfiles.id, existing.id));
    }

    const [latest] = await tx
      .select({ version: accountProfileVersions.version })
      .from(accountProfileVersions)
      .where(eq(accountProfileVersions.profileId, profile.id))
      .orderBy(desc(accountProfileVersions.version))
      .limit(1);

    const [version] = await tx
      .insert(accountProfileVersions)
      .values({
        profileId: profile.id,
        version: (latest?.version ?? 0) + 1,
        config: config as never,
        notes: input.notes ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();

    return {
      profileId: profile.id,
      profileKey: profile.key,
      profileName: input.name,
      accountType: input.accountType,
      versionId: version!.id,
      version: version!.version,
      config,
    };
  });
}

export async function listProfiles(db: Database, organizationId: string) {
  const profiles = await db
    .select()
    .from(accountProfiles)
    .where(eq(accountProfiles.organizationId, organizationId))
    .orderBy(accountProfiles.name);

  const out = [];
  for (const profile of profiles) {
    const [version] = await db
      .select()
      .from(accountProfileVersions)
      .where(eq(accountProfileVersions.profileId, profile.id))
      .orderBy(desc(accountProfileVersions.version))
      .limit(1);
    out.push({ profile, latest: version ?? null });
  }
  return out;
}

/** Every published version of one product, newest first. The version history. */
export async function listProfileVersions(db: Database, profileId: string) {
  return db
    .select()
    .from(accountProfileVersions)
    .where(eq(accountProfileVersions.profileId, profileId))
    .orderBy(desc(accountProfileVersions.version));
}

/**
 * Stop, or resume, selling a product.
 *
 * Retiring sets status RETIRED: `resolveProfileByKey` then refuses to provision
 * new accounts from it. It does not, and cannot, touch an account already
 * pinned to one of its versions - that is the whole point of pinning to a
 * version. Reactivating sets it back to ACTIVE.
 */
export async function setProfileStatus(
  db: Database,
  organizationId: string,
  profileId: string,
  status: 'ACTIVE' | 'RETIRED',
): Promise<{ id: string; key: string; name: string; status: string } | null> {
  const [updated] = await db
    .update(accountProfiles)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(accountProfiles.id, profileId), eq(accountProfiles.organizationId, organizationId)))
    .returning();
  if (!updated) return null;
  return { id: updated.id, key: updated.key, name: updated.name, status: updated.status };
}

export interface DraftInput {
  readonly organizationId: string;
  readonly key: string;
  readonly name: string;
  readonly accountType: string;
  readonly description?: string | null;
  readonly config: unknown;
  readonly notes?: string | null;
  readonly updatedByUserId?: string | null;
}

/**
 * Create or replace the working draft for a product key.
 *
 * The config is validated the same way a publish is, so a draft can never hold
 * terms the engine could not accept - the change preview shows real numbers,
 * not a shape that will be rejected at publish time. `baseVersion` records the
 * version the draft was started from, so the UI can warn when a newer version
 * was published underneath the draft.
 */
export async function saveDraft(db: Database, input: DraftInput) {
  const config = parseConfig(input.config);

  const [profile] = await db
    .select()
    .from(accountProfiles)
    .where(and(eq(accountProfiles.organizationId, input.organizationId), eq(accountProfiles.key, input.key)));

  let baseVersion: number | null = null;
  if (profile) {
    const [latest] = await db
      .select({ version: accountProfileVersions.version })
      .from(accountProfileVersions)
      .where(eq(accountProfileVersions.profileId, profile.id))
      .orderBy(desc(accountProfileVersions.version))
      .limit(1);
    baseVersion = latest?.version ?? null;
  }

  const [saved] = await db
    .insert(accountProfileDrafts)
    .values({
      organizationId: input.organizationId,
      profileId: profile?.id ?? null,
      key: input.key,
      name: input.name,
      accountType: input.accountType,
      description: input.description ?? null,
      config: config as never,
      notes: input.notes ?? null,
      baseVersion,
      updatedByUserId: input.updatedByUserId ?? null,
    })
    .onConflictDoUpdate({
      target: [accountProfileDrafts.organizationId, accountProfileDrafts.key],
      set: {
        profileId: profile?.id ?? null,
        name: input.name,
        accountType: input.accountType,
        description: input.description ?? null,
        config: config as never,
        notes: input.notes ?? null,
        baseVersion,
        updatedByUserId: input.updatedByUserId ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return saved!;
}

export async function getDraft(db: Database, organizationId: string, key: string) {
  const [draft] = await db
    .select()
    .from(accountProfileDrafts)
    .where(and(eq(accountProfileDrafts.organizationId, organizationId), eq(accountProfileDrafts.key, key)));
  return draft ?? null;
}

export async function discardDraft(
  db: Database,
  organizationId: string,
  key: string,
): Promise<boolean> {
  const deleted = await db
    .delete(accountProfileDrafts)
    .where(and(eq(accountProfileDrafts.organizationId, organizationId), eq(accountProfileDrafts.key, key)))
    .returning({ id: accountProfileDrafts.id });
  return deleted.length > 0;
}

/**
 * Publish the working draft as the next version, atomically.
 *
 * The draft is read, version N+1 is written, and the draft is deleted, all in
 * one transaction: there is never a moment where a published version and a
 * draft both claim to be "the edit". If nothing is drafted, this throws rather
 * than publishing an empty version.
 */
export async function publishDraft(
  db: Database,
  organizationId: string,
  key: string,
  actorUserId: string | null,
): Promise<ResolvedProfile> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(accountProfileDrafts)
      .where(
        and(eq(accountProfileDrafts.organizationId, organizationId), eq(accountProfileDrafts.key, key)),
      );
    if (!draft) throw new ProfileError('NO_VERSION', `No draft to publish for ${key}.`);

    const published = await publishProfileVersion(tx as unknown as Database, {
      organizationId,
      key: draft.key,
      name: draft.name,
      accountType: draft.accountType,
      description: draft.description,
      config: draft.config,
      notes: draft.notes,
      createdByUserId: actorUserId,
    });

    await tx.delete(accountProfileDrafts).where(eq(accountProfileDrafts.id, draft.id));
    return published;
  });
}
