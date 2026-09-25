/**
 * Affiliate attribution engine (M11-C).
 *
 * Server-authoritative, first-party. A click records a raw log row and upserts a
 * per-session touch (first + last) with an expiry = now + attribution window.
 * At purchase, `resolveAttribution` applies deterministic precedence:
 *   1. an explicit valid affiliate code entered at checkout  → source CODE
 *   2. otherwise a valid unexpired referral touch            → source LINK (last touch)
 *   3. otherwise no affiliate
 * First and last touch are both stored for analytics; commission uses the FINAL
 * attribution from these rules. Historical touches are never rewritten.
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from '../db/client.js';
import { affiliateClicks, affiliateTouches } from '../db/schema.js';
import { getAffiliateConfig } from './affiliate-config.js';
import { resolveActiveCode } from './affiliates.js';

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`htaff:${ip}`).digest('hex').slice(0, 64);
}

export interface ClickInput {
  readonly organizationId: string;
  readonly code: string;
  readonly sessionRef: string;
  readonly landingPath?: string | null;
  readonly campaign?: unknown;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Record a referral click and upsert the session's touch window. No-op for an
 * unknown/inactive code (we never attribute to a code that cannot earn). */
export async function recordClick(db: Database, input: ClickInput): Promise<{ recorded: boolean }> {
  const resolved = await resolveActiveCode(db, input.organizationId, input.code);
  if (!resolved) return { recorded: false };
  const cfg = await getAffiliateConfig(db, input.organizationId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + cfg.settings.attributionWindowDays * 86_400_000);
  await db.transaction(async (tx) => {
    await tx.insert(affiliateClicks).values({
      organizationId: input.organizationId, affiliateId: resolved.affiliateId, codeId: resolved.codeId,
      referralSlug: input.code.trim().slice(0, 40), sessionRef: input.sessionRef, landingPath: input.landingPath ?? null,
      campaign: (input.campaign ?? null) as never, ipHash: hashIp(input.ip), userAgent: (input.userAgent ?? '').slice(0, 400) || null,
    });
    const [existing] = await tx.select().from(affiliateTouches)
      .where(and(eq(affiliateTouches.organizationId, input.organizationId), eq(affiliateTouches.sessionRef, input.sessionRef)));
    if (existing) {
      await tx.update(affiliateTouches).set({
        lastTouchAffiliateId: resolved.affiliateId, lastTouchCodeId: resolved.codeId, lastTouchAt: now, expiresAt,
      }).where(eq(affiliateTouches.id, existing.id));
    } else {
      await tx.insert(affiliateTouches).values({
        organizationId: input.organizationId, sessionRef: input.sessionRef,
        firstTouchAffiliateId: resolved.affiliateId, firstTouchCodeId: resolved.codeId, firstTouchAt: now,
        lastTouchAffiliateId: resolved.affiliateId, lastTouchCodeId: resolved.codeId, lastTouchAt: now, expiresAt,
      });
    }
  });
  return { recorded: true };
}

export interface AttributionResult {
  readonly affiliateId: string;
  readonly codeId: string | null;
  readonly source: 'CODE' | 'LINK';
  readonly finalAttributionReason: string;
  readonly firstTouchAffiliateId: string | null;
  readonly lastTouchAffiliateId: string | null;
}

/** Deterministic conversion attribution. `explicitCode` (checkout) beats a link
 * touch; a link touch must be unexpired. Returns null when nothing attributes. */
export async function resolveAttribution(
  db: Database,
  organizationId: string,
  ctx: { sessionRef?: string | null; explicitCode?: string | null; at?: Date },
): Promise<AttributionResult | null> {
  const at = ctx.at ?? new Date();
  // Load any touch for analytics (first/last), even if expired.
  let touch: typeof affiliateTouches.$inferSelect | undefined;
  if (ctx.sessionRef) {
    [touch] = await db.select().from(affiliateTouches)
      .where(and(eq(affiliateTouches.organizationId, organizationId), eq(affiliateTouches.sessionRef, ctx.sessionRef)));
  }
  const firstTouchAffiliateId = touch?.firstTouchAffiliateId ?? null;
  const lastTouchAffiliateId = touch?.lastTouchAffiliateId ?? null;

  // 1. explicit valid code wins.
  if (ctx.explicitCode) {
    const resolved = await resolveActiveCode(db, organizationId, ctx.explicitCode);
    if (resolved) {
      return {
        affiliateId: resolved.affiliateId, codeId: resolved.codeId, source: 'CODE',
        finalAttributionReason: touch && touch.lastTouchAffiliateId !== resolved.affiliateId ? 'CHECKOUT_CODE_OVERRIDE' : 'CHECKOUT_CODE',
        firstTouchAffiliateId, lastTouchAffiliateId,
      };
    }
  }
  // 2. unexpired link touch (last touch).
  if (touch && touch.expiresAt > at) {
    return {
      affiliateId: touch.lastTouchAffiliateId, codeId: touch.lastTouchCodeId, source: 'LINK',
      finalAttributionReason: 'REFERRAL_LINK', firstTouchAffiliateId, lastTouchAffiliateId,
    };
  }
  // 3. none.
  return null;
}

/** Best-effort click stats for an affiliate (privacy-conscious aggregates). */
export async function clickStats(db: Database, affiliateId: string, since?: Date): Promise<{ clicks: number; uniqueSessions: number }> {
  const conds = [eq(affiliateClicks.affiliateId, affiliateId)];
  if (since) conds.push(gt(affiliateClicks.createdAt, since));
  const [row] = await db.select({
    clicks: sql<number>`count(*)::int`,
    uniqueSessions: sql<number>`count(distinct ${affiliateClicks.sessionRef})::int`,
  }).from(affiliateClicks).where(and(...conds));
  return { clicks: row?.clicks ?? 0, uniqueSessions: row?.uniqueSessions ?? 0 };
}
