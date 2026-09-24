/**
 * Versioned agreements + immutable acceptance.
 *
 * A material change publishes a NEW `agreement_versions` row (append-only, a
 * trigger rejects UPDATE/DELETE); a prior acceptance is NEVER overwritten. The
 * `content_hash` is the immutable identifier of exactly what was shown and
 * agreed. A required agreement whose current version is unaccepted gates
 * provisioning (see `provisioning-gate.ts`).
 *
 * V1 content is CLEARLY-LABELLED DEV PLACEHOLDER text — it is not counsel-approved
 * legal language, and it says so at the top of every body.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { agreementAcceptances, agreementVersions } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';

export type AgreementType = 'TERMS_OF_USE' | 'TRADER_PLEDGE' | 'PRIVACY' | 'RISK_DISCLOSURE';

export const AGREEMENT_TYPES: readonly AgreementType[] = [
  'TERMS_OF_USE',
  'TRADER_PLEDGE',
  'PRIVACY',
  'RISK_DISCLOSURE',
];

export type AgreementVersionRow = typeof agreementVersions.$inferSelect;

export class AgreementError extends Error {
  constructor(
    readonly code: 'VERSION_NOT_FOUND' | 'IDENTITY_MISMATCH' | 'MISSING_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'AgreementError';
  }
}

function contentHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Publish an agreement version. Idempotent on content: republishing identical
 * body for a type returns the existing version (the unique content_hash makes it
 * a no-op). Otherwise it appends the next version number for (org, type).
 */
export async function publishAgreementVersion(
  db: Database,
  input: {
    organizationId: string;
    agreementType: AgreementType;
    title: string;
    body: string;
    isRequired?: boolean;
    requiresReacceptance?: boolean;
    actor?: Actor;
  },
): Promise<AgreementVersionRow> {
  const hash = contentHash(input.body);
  const [existing] = await db
    .select()
    .from(agreementVersions)
    .where(
      and(
        eq(agreementVersions.organizationId, input.organizationId),
        eq(agreementVersions.agreementType, input.agreementType),
        eq(agreementVersions.contentHash, hash),
      ),
    );
  if (existing) return existing;

  const [latest] = await db
    .select({ version: agreementVersions.version })
    .from(agreementVersions)
    .where(
      and(
        eq(agreementVersions.organizationId, input.organizationId),
        eq(agreementVersions.agreementType, input.agreementType),
      ),
    )
    .orderBy(desc(agreementVersions.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  const actor = input.actor ?? SYSTEM_ACTOR;
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [row] = await tx
      .insert(agreementVersions)
      .values({
        organizationId: input.organizationId,
        agreementType: input.agreementType,
        version: nextVersion,
        title: input.title,
        body: input.body,
        contentHash: hash,
        isRequired: input.isRequired ?? true,
        requiresReacceptance: input.requiresReacceptance ?? false,
      })
      .onConflictDoNothing({
        target: [
          agreementVersions.organizationId,
          agreementVersions.agreementType,
          agreementVersions.contentHash,
        ],
      })
      .returning();
    if (!row) {
      const [winner] = await tx
        .select()
        .from(agreementVersions)
        .where(
          and(
            eq(agreementVersions.organizationId, input.organizationId),
            eq(agreementVersions.agreementType, input.agreementType),
            eq(agreementVersions.contentHash, hash),
          ),
        );
      return winner!;
    }
    await recordAudit(scoped, {
      organizationId: input.organizationId,
      actor,
      subjectType: 'AGREEMENT',
      subjectId: row.id,
      action: 'agreement.version_published',
      newState: { agreementType: input.agreementType, version: nextVersion, contentHash: hash },
      reason: null,
    });
    return row;
  });
}

const PLACEHOLDER_HEADER =
  '> DEVELOPMENT PLACEHOLDER — not legal advice, not counsel-approved, not the ' +
  'final agreement. This text exists so the acceptance flow can be built and ' +
  'tested; it must be replaced with counsel-approved language before launch.\n\n';

const DEFAULT_AGREEMENTS: ReadonlyArray<{ type: AgreementType; title: string; body: string }> = [
  {
    type: 'TERMS_OF_USE',
    title: 'Terms of Use',
    body:
      PLACEHOLDER_HEADER +
      'You agree to use the Happy Trader platform for simulated evaluation and ' +
      'funded-simulation trading only, in accordance with the trading standards ' +
      'and the account rules of the product you purchase.',
  },
  {
    type: 'TRADER_PLEDGE',
    title: 'Trader Pledge & Trading Standards',
    body:
      PLACEHOLDER_HEADER +
      'You pledge to trade the account yourself, without prohibited automation, ' +
      'copy-trading across accounts, or coordinated group trading, and to respect ' +
      "each product's consistency and risk rules.",
  },
  {
    type: 'PRIVACY',
    title: 'Privacy Notice',
    body:
      PLACEHOLDER_HEADER +
      'We process the identity and contact information you provide to verify who ' +
      'you are and to operate your account. We do not sell your personal data.',
  },
  {
    type: 'RISK_DISCLOSURE',
    title: 'Risk Disclosure',
    body:
      PLACEHOLDER_HEADER +
      'Simulated trading results are not indicative of real trading. Evaluation ' +
      'and funded-simulation accounts do not involve trading real capital in your ' +
      'name during V1.',
  },
];

/** Publish v1 of every required agreement if none exists yet. Idempotent. */
export async function seedDefaultAgreements(db: Database, organizationId: string): Promise<void> {
  for (const a of DEFAULT_AGREEMENTS) {
    await publishAgreementVersion(db, {
      organizationId,
      agreementType: a.type,
      title: a.title,
      body: a.body,
      isRequired: true,
    });
  }
}

/** The current (highest-version) row for each agreement type. */
export async function currentAgreementVersions(
  db: Database,
  organizationId: string,
): Promise<AgreementVersionRow[]> {
  const all = await db
    .select()
    .from(agreementVersions)
    .where(eq(agreementVersions.organizationId, organizationId))
    .orderBy(desc(agreementVersions.version));
  const byType = new Map<string, AgreementVersionRow>();
  for (const row of all) {
    if (!byType.has(row.agreementType)) byType.set(row.agreementType, row);
  }
  return [...byType.values()];
}

/**
 * The required agreement types whose CURRENT version this identity has not yet
 * accepted — the agreement half of the provisioning gate. A newer required
 * version (even with an old acceptance on file) counts as outstanding.
 */
export async function outstandingAgreements(
  db: Database,
  organizationId: string,
  identityId: string,
): Promise<Array<{ agreementType: AgreementType; versionId: string; version: number }>> {
  const current = (await currentAgreementVersions(db, organizationId)).filter((v) => v.isRequired);
  if (current.length === 0) return [];
  const accepted = await db
    .select({ agreementVersionId: agreementAcceptances.agreementVersionId })
    .from(agreementAcceptances)
    .where(eq(agreementAcceptances.customerIdentityId, identityId));
  const acceptedIds = new Set(accepted.map((a) => a.agreementVersionId));
  return current
    .filter((v) => !acceptedIds.has(v.id))
    .map((v) => ({ agreementType: v.agreementType as AgreementType, versionId: v.id, version: v.version }));
}

/**
 * Record immutable acceptances. Unique per (identity, version) makes a
 * double-submit a no-op. Copies the content hash at acceptance and stores the
 * security metadata. Never overwrites a prior acceptance.
 */
export async function acceptAgreements(
  db: Database,
  input: {
    organizationId: string;
    identityId: string;
    userId: string;
    versionIds: string[];
    sessionMeta?: Record<string, unknown>;
    actor?: Actor;
  },
): Promise<{ accepted: number }> {
  if (input.versionIds.length === 0) return { accepted: 0 };
  const versions = await db
    .select()
    .from(agreementVersions)
    .where(
      and(
        eq(agreementVersions.organizationId, input.organizationId),
        inArray(agreementVersions.id, input.versionIds),
      ),
    );
  if (versions.length !== input.versionIds.length) {
    throw new AgreementError('VERSION_NOT_FOUND', 'One or more agreement versions do not exist.');
  }
  const actor = input.actor ?? SYSTEM_ACTOR;
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    let accepted = 0;
    for (const v of versions) {
      const [row] = await tx
        .insert(agreementAcceptances)
        .values({
          organizationId: input.organizationId,
          customerIdentityId: input.identityId,
          agreementVersionId: v.id,
          agreementType: v.agreementType,
          contentHash: v.contentHash,
          userId: input.userId,
          sessionMeta: (input.sessionMeta ?? null) as object | null,
        })
        .onConflictDoNothing({
          target: [agreementAcceptances.customerIdentityId, agreementAcceptances.agreementVersionId],
        })
        .returning();
      if (row) {
        accepted += 1;
        await recordAudit(scoped, {
          organizationId: input.organizationId,
          actor,
          subjectType: 'AGREEMENT',
          subjectId: v.id,
          userId: input.userId,
          action: 'agreement.accepted',
          newState: { agreementType: v.agreementType, version: v.version, contentHash: v.contentHash },
          reason: null,
        });
        await events.publish(scoped, {
          type: 'agreement.accepted',
          organizationId: input.organizationId,
          userId: input.userId,
          payload: {
            customerIdentityId: input.identityId,
            agreementType: v.agreementType,
            version: v.version,
          },
        });
      }
    }
    return { accepted };
  });
}

/** The acceptance history for an identity, newest first. */
export async function acceptedAgreements(db: Database, identityId: string) {
  return db
    .select()
    .from(agreementAcceptances)
    .where(eq(agreementAcceptances.customerIdentityId, identityId))
    .orderBy(desc(agreementAcceptances.acceptedAt));
}
