/**
 * Affiliate lifecycle domain (M11): application → review → approval → agreement →
 * activation → code/link. Approval does NOT activate; a code/link exists only
 * after the required agreement is accepted while ACTIVE. Every state is persisted
 * and audited.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  affiliateAgreementAcceptances, affiliateApplications, affiliateCodes, affiliateRateHistory,
  affiliates, agreementVersions, customerIdentities, users,
} from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import { publishAgreementVersion } from './agreements.js';
import { getAffiliateConfig, tierRateBps, type AffiliateTier } from './affiliate-config.js';
import type { Actor } from './actor.js';

export type AffiliateStatus =
  | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED_PENDING_AGREEMENT' | 'ACTIVE'
  | 'ACTIVE_PENDING_UPDATED_AGREEMENT' | 'PAUSED' | 'SUSPENDED' | 'TERMINATED' | 'DECLINED';

export type AffiliateRow = typeof affiliates.$inferSelect;

const RESERVED_CODES = new Set([
  'admin', 'affiliate', 'affiliates', 'api', 'app', 'checkout', 'happytrader', 'happytraderfunding',
  'support', 'help', 'owner', 'staff', 'system', 'root', 'null', 'undefined', 'test', 'ref', 'code',
  'login', 'signup', 'register', 'account', 'accounts', 'payout', 'payouts', 'commission',
]);

const CODE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

/** Lower-case, trimmed canonical form. NATE, nate and Nate all canonicalize to "nate". */
export function canonicalizeCode(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export function validateCode(raw: string): string {
  const canonical = canonicalizeCode(raw);
  if (!CODE_RE.test(canonical)) {
    throw ApiError.badRequest('INVALID_CODE', 'Code must be 3–32 chars, letters/numbers/-/_ only, starting alphanumeric.');
  }
  if (RESERVED_CODES.has(canonical)) throw ApiError.badRequest('RESERVED_CODE', 'That code is reserved.');
  return canonical;
}

function publicId(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString('hex').toUpperCase().slice(0, 8)}`;
}

// --- applications ----------------------------------------------------------

export interface ApplicationInput {
  readonly organizationId: string;
  readonly userId?: string | null;
  readonly fullName: string;
  readonly email: string;
  readonly brandName?: string | null;
  readonly primaryPlatform?: string | null;
  readonly profileUrl?: string | null;
  readonly audienceSize?: string | null;
  readonly audienceDescription?: string | null;
  readonly promotionPlan?: string | null;
  readonly country?: string | null;
  readonly extraLinks?: unknown;
  readonly actor?: Actor;
}

/** Submit an affiliate application. Creates the affiliate (SUBMITTED) + the form
 * record. Idempotent-ish: a logged-in user with an existing non-declined affiliate
 * is refused a duplicate. */
export async function submitApplication(db: Database, input: ApplicationInput): Promise<{ affiliateId: string; applicationId: string }> {
  const cfg = await getAffiliateConfig(db, input.organizationId);
  if (!cfg.settings.applicationsEnabled) throw ApiError.badRequest('APPLICATIONS_CLOSED', 'The partner program is not accepting applications right now.');
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw ApiError.badRequest('INVALID_EMAIL', 'A valid email is required.');
  if (input.fullName.trim().length < 2) throw ApiError.badRequest('INVALID_NAME', 'A name is required.');

  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    // Prevent duplicate active applications for the same logged-in user.
    if (input.userId) {
      const [existing] = await tx.select({ id: affiliates.id, status: affiliates.status }).from(affiliates)
        .where(and(eq(affiliates.organizationId, input.organizationId), eq(affiliates.userId, input.userId)));
      if (existing && existing.status !== 'DECLINED') {
        throw ApiError.conflict('ALREADY_APPLIED', 'You already have an affiliate application or account.');
      }
    }
    let identityId: string | null = null;
    if (input.userId) {
      const [ident] = await tx.select({ id: customerIdentities.id }).from(customerIdentities).where(eq(customerIdentities.userId, input.userId));
      identityId = ident?.id ?? null;
    }
    const [aff] = await tx.insert(affiliates).values({
      organizationId: input.organizationId,
      publicId: publicId('HT-AFF'),
      userId: input.userId ?? null,
      customerIdentityId: identityId,
      displayName: (input.brandName || input.fullName).trim().slice(0, 120),
      email,
      status: 'SUBMITTED',
      tier: cfg.settings.defaultTier,
      tierRateBps: tierRateBps(cfg.settings, cfg.settings.defaultTier),
      effectiveRateBps: tierRateBps(cfg.settings, cfg.settings.defaultTier),
    }).returning();
    const [app] = await tx.insert(affiliateApplications).values({
      organizationId: input.organizationId,
      affiliateId: aff!.id,
      status: 'SUBMITTED',
      fullName: input.fullName.trim().slice(0, 160),
      email,
      brandName: input.brandName ?? null,
      primaryPlatform: input.primaryPlatform ?? null,
      profileUrl: input.profileUrl ?? null,
      audienceSize: input.audienceSize ?? null,
      audienceDescription: input.audienceDescription ?? null,
      promotionPlan: input.promotionPlan ?? null,
      country: input.country ?? null,
      extraLinks: (input.extraLinks ?? null) as never,
    }).returning();
    await recordAudit(scoped, {
      organizationId: input.organizationId, actor: input.actor ?? { type: 'USER', userId: input.userId ?? null, label: email },
      subjectType: 'AFFILIATE', subjectId: null, userId: input.userId ?? null,
      action: 'affiliate.application.submitted', newState: { affiliateId: aff!.id, publicId: aff!.publicId }, reason: 'application submitted',
    });
    return { affiliateId: aff!.id, applicationId: app!.id };
  });
}

// --- review ----------------------------------------------------------------

export async function reviewApplication(
  db: Database,
  affiliateId: string,
  decision: 'APPROVE' | 'DECLINE' | 'REQUEST_INFO',
  actor: Actor,
  opts: { notes?: string; declineReason?: string } = {},
): Promise<void> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [aff] = await tx.select().from(affiliates).where(eq(affiliates.id, affiliateId));
    if (!aff) throw ApiError.notFound('AFFILIATE_NOT_FOUND', 'Affiliate not found.');
    if (!['SUBMITTED', 'UNDER_REVIEW', 'APPROVED_PENDING_AGREEMENT'].includes(aff.status)) {
      throw ApiError.badRequest('NOT_REVIEWABLE', `An affiliate in ${aff.status} cannot be reviewed.`);
    }
    const nextStatus: AffiliateStatus = decision === 'APPROVE' ? 'APPROVED_PENDING_AGREEMENT' : decision === 'DECLINE' ? 'DECLINED' : 'UNDER_REVIEW';
    const appStatus = decision === 'APPROVE' ? 'APPROVED_PENDING_AGREEMENT' : decision === 'DECLINE' ? 'DECLINED' : 'MORE_INFO';
    await tx.update(affiliates).set({ status: nextStatus, updatedAt: new Date() }).where(eq(affiliates.id, affiliateId));
    await tx.update(affiliateApplications).set({
      status: appStatus, reviewedByUserId: actor.userId ?? null, reviewedAt: new Date(),
      reviewNotes: opts.notes ?? null, declineReason: opts.declineReason ?? null,
    }).where(eq(affiliateApplications.affiliateId, affiliateId));
    await recordAudit(scoped, {
      organizationId: aff.organizationId, actor, subjectType: 'AFFILIATE', subjectId: null, userId: aff.userId,
      action: `affiliate.application.${decision.toLowerCase()}`, prevState: { status: aff.status }, newState: { status: nextStatus },
      reason: opts.declineReason ?? opts.notes ?? decision,
    });
    const evt = decision === 'APPROVE' ? 'affiliate.approved' : decision === 'DECLINE' ? 'affiliate.declined' : 'affiliate.info_requested';
  });
}

// --- agreement + activation ------------------------------------------------

const AFFILIATE_AGREEMENT_TITLE = 'Happy Trader Affiliate Agreement';
/** A clearly-marked WORKING agreement template. Final language requires counsel review. */
export const AFFILIATE_AGREEMENT_WORKING_BODY = `# Happy Trader Affiliate Agreement (WORKING DRAFT — pending legal review)

This is an operational working template. Final legal language must be reviewed and
approved by counsel before production launch.

1. Commission. Happy Trader pays commission on qualified referred revenue at the
   rate shown in your dashboard (default 15%), subject to performance tiers.
2. Tiers & qualification. Rates may change based on monthly qualified revenue.
   Historical commissions are not retroactively changed.
3. Attribution. Commission is earned only on purchases attributed to you within
   the attribution window, per the program's deterministic precedence rules.
4. Maturity. Commissions mature after a holding window to allow refund/chargeback
   risk to clear before they become payable.
5. Refunds & chargebacks. Refunded or charged-back purchases reverse the related
   commission; paid reversals create a negative balance against future earnings.
6. Payouts. Payouts are made when a real payout method is configured and the
   minimum threshold is met.
7. Self-referrals are not eligible for commission.
8. No misleading advertising. You must not make guaranteed-income or guaranteed-
   profitability claims, misrepresent Happy Trader's rules, or use the brand without
   permission. You are responsible for appropriate affiliate disclosures.
9. Suspension & termination. Happy Trader may suspend or terminate participation
   for abuse or breach; earned, non-reversed commissions are preserved.
10. Program changes. Happy Trader may update this program and this agreement;
    material changes may require re-acceptance.
`;

/** Publish (idempotent) the working affiliate agreement version for the org. */
export async function ensureAffiliateAgreement(db: Database, organizationId: string, actor?: Actor): Promise<{ id: string; version: number; contentHash: string }> {
  const v = await publishAgreementVersion(db, {
    organizationId, agreementType: 'AFFILIATE_AGREEMENT', title: AFFILIATE_AGREEMENT_TITLE,
    body: AFFILIATE_AGREEMENT_WORKING_BODY, isRequired: true, actor,
  });
  return { id: v.id, version: v.version, contentHash: v.contentHash };
}

/** The current affiliate agreement version for the org (publishing it if absent). */
export async function currentAffiliateAgreement(db: Database, organizationId: string): Promise<{ id: string; version: number; contentHash: string; title: string; body: string }> {
  const [row] = await db.select().from(agreementVersions)
    .where(and(eq(agreementVersions.organizationId, organizationId), eq(agreementVersions.agreementType, 'AFFILIATE_AGREEMENT')))
    .orderBy(desc(agreementVersions.version)).limit(1);
  if (row) return { id: row.id, version: row.version, contentHash: row.contentHash, title: row.title, body: row.body };
  const v = await ensureAffiliateAgreement(db, organizationId);
  const [fresh] = await db.select().from(agreementVersions).where(eq(agreementVersions.id, v.id));
  return { id: fresh!.id, version: fresh!.version, contentHash: fresh!.contentHash, title: fresh!.title, body: fresh!.body };
}

/** Accept the affiliate agreement and ACTIVATE the affiliate (generates the primary code/link). */
export async function acceptAffiliateAgreement(
  db: Database,
  affiliateId: string,
  evidence: { ip?: string | null; userAgent?: string | null; sessionRef?: string | null; actor?: Actor },
): Promise<{ status: AffiliateStatus; code: string }> {
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [aff] = await tx.select().from(affiliates).where(eq(affiliates.id, affiliateId));
    if (!aff) throw ApiError.notFound('AFFILIATE_NOT_FOUND', 'Affiliate not found.');
    if (!['APPROVED_PENDING_AGREEMENT', 'ACTIVE_PENDING_UPDATED_AGREEMENT'].includes(aff.status)) {
      throw ApiError.badRequest('NOT_PENDING_AGREEMENT', `Affiliate in ${aff.status} cannot accept the agreement now.`);
    }
    const agreement = await currentAffiliateAgreement(scoped, aff.organizationId);
    await tx.insert(affiliateAgreementAcceptances).values({
      organizationId: aff.organizationId, affiliateId, agreementVersionId: agreement.id, contentHash: agreement.contentHash,
      ip: evidence.ip ?? null, userAgent: evidence.userAgent ?? null, sessionRef: evidence.sessionRef ?? null,
    }).onConflictDoNothing({ target: [affiliateAgreementAcceptances.affiliateId, affiliateAgreementAcceptances.agreementVersionId] });
    await tx.update(affiliates).set({
      status: 'ACTIVE', agreementAcceptedVersionId: agreement.id, needsAgreementReacceptance: false,
      activatedAt: aff.activatedAt ?? new Date(), updatedAt: new Date(),
    }).where(eq(affiliates.id, affiliateId));
    const code = await ensurePrimaryCodeTx(tx, aff);
    await recordAudit(scoped, {
      organizationId: aff.organizationId, actor: evidence.actor ?? { type: 'USER', userId: aff.userId, label: aff.email },
      subjectType: 'AFFILIATE', subjectId: null, userId: aff.userId, action: 'affiliate.agreement.accepted',
      newState: { agreementVersionId: agreement.id, version: agreement.version, code }, reason: 'affiliate agreement accepted; activated',
    });
    return { status: 'ACTIVE', code };
  });
}

// --- codes -----------------------------------------------------------------

function suggestCode(aff: AffiliateRow): string {
  const base = canonicalizeCode(aff.displayName).replace(/[^a-z0-9]/g, '').slice(0, 12);
  if (base.length >= 3 && !RESERVED_CODES.has(base)) return base;
  return `htp${randomBytes(3).toString('hex')}`;
}

async function ensurePrimaryCodeTx(tx: Parameters<Parameters<Database['transaction']>[0]>[0], aff: AffiliateRow): Promise<string> {
  const [existing] = await tx.select().from(affiliateCodes)
    .where(and(eq(affiliateCodes.affiliateId, aff.id), eq(affiliateCodes.kind, 'PRIMARY')));
  if (existing) return existing.code;
  let code = suggestCode(aff);
  for (let i = 0; i < 6; i += 1) {
    const canonical = canonicalizeCode(code);
    const [clash] = await tx.select({ id: affiliateCodes.id }).from(affiliateCodes)
      .where(and(eq(affiliateCodes.organizationId, aff.organizationId), eq(affiliateCodes.codeCanonical, canonical)));
    if (!clash) {
      await tx.insert(affiliateCodes).values({
        organizationId: aff.organizationId, affiliateId: aff.id, code, codeCanonical: canonical, kind: 'PRIMARY', status: 'ACTIVE',
      });
      return code;
    }
    code = `${suggestCode(aff)}${randomBytes(2).toString('hex')}`;
  }
  throw ApiError.conflict('CODE_GENERATION_FAILED', 'Could not generate a unique code.');
}

/** Resolve an ACTIVE code (canonical) to its affiliate + discount, if any. */
export async function resolveActiveCode(db: Database, organizationId: string, raw: string): Promise<{ affiliateId: string; codeId: string; discountBps: number | null } | null> {
  const canonical = canonicalizeCode(raw);
  if (!CODE_RE.test(canonical)) return null;
  const [row] = await db.select({ id: affiliateCodes.id, affiliateId: affiliateCodes.affiliateId, discountBps: affiliateCodes.discountBps, status: affiliateCodes.status, affStatus: affiliates.status })
    .from(affiliateCodes).innerJoin(affiliates, eq(affiliateCodes.affiliateId, affiliates.id))
    .where(and(eq(affiliateCodes.organizationId, organizationId), eq(affiliateCodes.codeCanonical, canonical), eq(affiliateCodes.status, 'ACTIVE')));
  if (!row) return null;
  if (row.affStatus !== 'ACTIVE') return null; // code inert unless affiliate ACTIVE
  return { affiliateId: row.affiliateId, codeId: row.id, discountBps: row.discountBps };
}

export async function listAffiliateCodes(db: Database, affiliateId: string) {
  return db.select().from(affiliateCodes).where(eq(affiliateCodes.affiliateId, affiliateId)).orderBy(desc(affiliateCodes.createdAt));
}

export async function createCampaignCode(db: Database, affiliateId: string, raw: string, opts: { discountBps?: number | null; campaignLabel?: string; actor: Actor }): Promise<{ id: string; code: string }> {
  const canonical = validateCode(raw);
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
  if (!aff) throw ApiError.notFound('AFFILIATE_NOT_FOUND', 'Affiliate not found.');
  const [clash] = await db.select({ id: affiliateCodes.id }).from(affiliateCodes)
    .where(and(eq(affiliateCodes.organizationId, aff.organizationId), eq(affiliateCodes.codeCanonical, canonical)));
  if (clash) throw ApiError.conflict('CODE_TAKEN', 'That code is already in use.');
  const [row] = await db.insert(affiliateCodes).values({
    organizationId: aff.organizationId, affiliateId, code: raw.trim(), codeCanonical: canonical, kind: 'CAMPAIGN',
    status: 'ACTIVE', discountBps: opts.discountBps ?? null, campaignLabel: opts.campaignLabel ?? null, createdByUserId: opts.actor.userId ?? null,
  }).returning();
  await recordAudit(db, { organizationId: aff.organizationId, actor: opts.actor, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.code.created', newState: { code: raw, canonical }, reason: 'campaign code created' });
  return { id: row!.id, code: row!.code };
}

export async function setCodeStatus(db: Database, codeId: string, status: 'ACTIVE' | 'DISABLED', actor: Actor): Promise<void> {
  const [code] = await db.select().from(affiliateCodes).where(eq(affiliateCodes.id, codeId));
  if (!code) throw ApiError.notFound('CODE_NOT_FOUND', 'Code not found.');
  await db.update(affiliateCodes).set({ status, disabledAt: status === 'DISABLED' ? new Date() : null }).where(eq(affiliateCodes.id, codeId));
  await recordAudit(db, { organizationId: code.organizationId, actor, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.code.status', prevState: { status: code.status }, newState: { status }, reason: `code ${status.toLowerCase()}` });
}

// --- rate / tier / status --------------------------------------------------

/** Effective rate: custom override (if set and in effect) wins over tier rate. */
export function computeEffectiveRateBps(aff: Pick<AffiliateRow, 'tierRateBps' | 'customRateBps' | 'customRateEffectiveAt' | 'customRateExpiresAt'>, at: Date = new Date()): { bps: number; source: 'CUSTOM' | 'TIER' } {
  const hasCustom = aff.customRateBps != null
    && (!aff.customRateEffectiveAt || aff.customRateEffectiveAt <= at)
    && (!aff.customRateExpiresAt || aff.customRateExpiresAt > at);
  if (hasCustom) return { bps: aff.customRateBps!, source: 'CUSTOM' };
  return { bps: aff.tierRateBps, source: 'TIER' };
}

export async function changeAffiliateRate(db: Database, affiliateId: string, customRateBps: number | null, actor: Actor, opts: { reason: string; effectiveAt?: Date; expiresAt?: Date | null } = { reason: 'manual rate change' }): Promise<void> {
  if (customRateBps != null && (customRateBps < 0 || customRateBps > 10000)) throw ApiError.badRequest('INVALID_RATE', 'Rate must be between 0 and 10000 bps.');
  return db.transaction(async (tx) => {
    const scoped = tx as unknown as Database;
    const [aff] = await tx.select().from(affiliates).where(eq(affiliates.id, affiliateId));
    if (!aff) throw ApiError.notFound('AFFILIATE_NOT_FOUND', 'Affiliate not found.');
    const prior = aff.effectiveRateBps;
    const merged = { ...aff, customRateBps, customRateEffectiveAt: opts.effectiveAt ?? new Date(), customRateExpiresAt: opts.expiresAt ?? null };
    const eff = computeEffectiveRateBps(merged);
    await tx.update(affiliates).set({
      customRateBps, customRateReason: customRateBps != null ? opts.reason : null,
      customRateEffectiveAt: customRateBps != null ? (opts.effectiveAt ?? new Date()) : null,
      customRateExpiresAt: customRateBps != null ? (opts.expiresAt ?? null) : null,
      effectiveRateBps: eff.bps, tier: customRateBps != null ? 'STRATEGIC' : aff.tier, updatedAt: new Date(),
    }).where(eq(affiliates.id, affiliateId));
    await tx.insert(affiliateRateHistory).values({
      organizationId: aff.organizationId, affiliateId, priorRateBps: prior, newRateBps: eff.bps,
      source: customRateBps != null ? 'CUSTOM' : 'TIER', reason: opts.reason, effectiveAt: opts.effectiveAt ?? new Date(),
      expiresAt: opts.expiresAt ?? null, staffActorUserId: actor.userId ?? null,
    });
    await recordAudit(scoped, { organizationId: aff.organizationId, actor, subjectType: 'AFFILIATE', subjectId: null, action: 'affiliate.rate.changed', prevState: { effectiveRateBps: prior }, newState: { effectiveRateBps: eff.bps, source: eff.source }, reason: opts.reason });
  });
}

export async function setAffiliateStatus(db: Database, affiliateId: string, status: Extract<AffiliateStatus, 'PAUSED' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED'>, actor: Actor, reason: string): Promise<void> {
  const [aff] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
  if (!aff) throw ApiError.notFound('AFFILIATE_NOT_FOUND', 'Affiliate not found.');
  if (status === 'ACTIVE' && !['PAUSED', 'SUSPENDED'].includes(aff.status)) throw ApiError.badRequest('CANNOT_RESUME', `Cannot resume an affiliate in ${aff.status}.`);
  await db.update(affiliates).set({ status, updatedAt: new Date() }).where(eq(affiliates.id, affiliateId));
  await recordAudit(db, { organizationId: aff.organizationId, actor, subjectType: 'AFFILIATE', subjectId: null, userId: aff.userId, action: `affiliate.status.${status.toLowerCase()}`, prevState: { status: aff.status }, newState: { status }, reason });
}

// --- reads -----------------------------------------------------------------

export async function getAffiliate(db: Database, affiliateId: string): Promise<AffiliateRow | null> {
  const [row] = await db.select().from(affiliates).where(eq(affiliates.id, affiliateId));
  return row ?? null;
}

export async function affiliateForUser(db: Database, organizationId: string, userId: string): Promise<AffiliateRow | null> {
  const [row] = await db.select().from(affiliates).where(and(eq(affiliates.organizationId, organizationId), eq(affiliates.userId, userId)));
  return row ?? null;
}

export async function listApplications(db: Database, organizationId: string, opts: { status?: string; limit?: number } = {}) {
  const conds = [eq(affiliateApplications.organizationId, organizationId)];
  if (opts.status) conds.push(eq(affiliateApplications.status, opts.status));
  return db.select().from(affiliateApplications).where(and(...conds)).orderBy(desc(affiliateApplications.submittedAt)).limit(Math.min(opts.limit ?? 100, 500));
}

export async function listAffiliates(db: Database, organizationId: string, opts: { status?: string; q?: string; limit?: number } = {}) {
  const conds = [eq(affiliates.organizationId, organizationId)];
  if (opts.status) conds.push(eq(affiliates.status, opts.status));
  if (opts.q && opts.q.length >= 2) {
    const like = `%${opts.q}%`;
    conds.push(or(ilike(affiliates.displayName, like), ilike(affiliates.email, like), ilike(affiliates.publicId, like))!);
  }
  return db.select().from(affiliates).where(and(...conds)).orderBy(desc(affiliates.createdAt)).limit(Math.min(opts.limit ?? 100, 500));
}

/** A masked customer label for affiliate-facing views (privacy §35). */
export function maskName(name: string): string {
  return name.split(/\s+/).map((p) => (p ? `${p[0]!.toUpperCase()}${'*'.repeat(Math.max(1, Math.min(3, p.length - 1)))}` : '')).join(' ').trim() || 'Customer';
}

void inArray; void sql; void users; void createHash;
