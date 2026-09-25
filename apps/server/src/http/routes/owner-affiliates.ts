/**
 * Owner affiliate operations (M11-I). Mounted at /api/v1/admin/ops. Every route is
 * permission-gated; rate/adjustment/config/payout-pay are owner-tier and require a
 * FINANCIAL step-up. All staff actions are audited by the domain services.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireReauth, actorFromRequest } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import {
  listApplications, listAffiliates, getAffiliate, reviewApplication, changeAffiliateRate,
  setAffiliateStatus, setCodeStatus, createCampaignCode,
} from '../../platform/affiliates.js';
import { ownerAffiliateOverview, affiliate360 } from '../../platform/affiliate-analytics.js';
import { manualAdjustment, matureCommissions } from '../../platform/affiliate-commissions.js';
import { setTierManual, recalcAllTiers } from '../../platform/affiliate-tiers.js';
import { getAffiliateConfig, updateAffiliateConfig, AFFILIATE_TIERS } from '../../platform/affiliate-config.js';
import { approvePayout, cancelPayout, failPayout, markPayoutPaid } from '../../platform/affiliate-payouts.js';

export function ownerAffiliateRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    app.get('/affiliates/overview', { preHandler: requirePermission('affiliates.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return ownerAffiliateOverview(db, org);
    });

    app.get('/affiliates/applications', { preHandler: requirePermission('affiliates.applications.review') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ status: z.string().optional() }).parse(request.query ?? {});
      return { applications: await listApplications(db, org, q) };
    });

    app.post('/affiliates/:id/review', { preHandler: requirePermission('affiliates.applications.review') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ decision: z.enum(['APPROVE', 'DECLINE', 'REQUEST_INFO']), notes: z.string().max(2000).optional(), declineReason: z.string().max(2000).optional() }).parse(request.body);
      await reviewApplication(db, id, b.decision, actorFromRequest(request), { notes: b.notes, declineReason: b.declineReason });
      return { ok: true };
    });

    app.get('/affiliates', { preHandler: requirePermission('affiliates.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ status: z.string().optional(), q: z.string().optional() }).parse(request.query ?? {});
      return { affiliates: await listAffiliates(db, org, q) };
    });

    app.get('/affiliates/:id', { preHandler: requirePermission('affiliates.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const view = await affiliate360(db, id);
      if (!view) return { found: false };
      return view;
    });

    // Rate change — owner-tier + FINANCIAL step-up.
    app.post('/affiliates/:id/rate', { preHandler: [requirePermission('affiliates.rates.manage'), requireReauth('FINANCIAL')] }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ customRateBps: z.number().int().min(0).max(10000).nullable(), reason: z.string().min(3).max(500), expiresAt: z.coerce.date().nullable().optional() }).parse(request.body);
      await changeAffiliateRate(db, id, b.customRateBps, actorFromRequest(request), { reason: b.reason, expiresAt: b.expiresAt ?? null });
      return { ok: true };
    });

    app.post('/affiliates/:id/tier', { preHandler: [requirePermission('affiliates.rates.manage'), requireReauth('FINANCIAL')] }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ tier: z.enum(AFFILIATE_TIERS), reason: z.string().min(3).max(500) }).parse(request.body);
      await setTierManual(db, id, b.tier, actorFromRequest(request), b.reason);
      return { ok: true };
    });

    app.post('/affiliates/:id/status', { preHandler: requirePermission('affiliates.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'SUSPENDED', 'TERMINATED']), reason: z.string().min(3).max(500) }).parse(request.body);
      await setAffiliateStatus(db, id, b.status, actorFromRequest(request), b.reason);
      return { ok: true };
    });

    // Commission adjustment — owner-tier + FINANCIAL step-up.
    app.post('/affiliates/:id/adjust', { preHandler: [requirePermission('affiliates.commissions.adjust'), requireReauth('FINANCIAL')] }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const org = await defaultOrganizationId(db);
      const b = z.object({ amountMicros: z.number().int(), reasonCode: z.string().min(2).max(40), explanation: z.string().min(5).max(1000) }).parse(request.body);
      await manualAdjustment(db, { organizationId: org, affiliateId: id, amountMicros: b.amountMicros, reasonCode: b.reasonCode, explanation: b.explanation, actor: actorFromRequest(request) });
      return { ok: true };
    });

    // Codes.
    app.post('/affiliates/:id/codes', { preHandler: requirePermission('affiliates.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ code: z.string().min(3).max(40), discountBps: z.number().int().min(0).max(10000).nullable().optional(), campaignLabel: z.string().max(120).optional() }).parse(request.body);
      return createCampaignCode(db, id, b.code, { discountBps: b.discountBps ?? null, campaignLabel: b.campaignLabel, actor: actorFromRequest(request) });
    });
    app.post('/affiliates/codes/:codeId/status', { preHandler: requirePermission('affiliates.manage') }, async (request) => {
      const { codeId } = z.object({ codeId: z.string().uuid() }).parse(request.params);
      const b = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).parse(request.body);
      await setCodeStatus(db, codeId, b.status, actorFromRequest(request));
      return { ok: true };
    });

    // Payout operations.
    app.post('/affiliates/payouts/:payoutId/approve', { preHandler: requirePermission('affiliates.payouts.manage') }, async (request) => {
      const { payoutId } = z.object({ payoutId: z.string().uuid() }).parse(request.params);
      await approvePayout(db, payoutId, actorFromRequest(request));
      return { ok: true };
    });
    app.post('/affiliates/payouts/:payoutId/cancel', { preHandler: requirePermission('affiliates.payouts.manage') }, async (request) => {
      const { payoutId } = z.object({ payoutId: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      await cancelPayout(db, payoutId, actorFromRequest(request), b.reason);
      return { ok: true };
    });
    app.post('/affiliates/payouts/:payoutId/fail', { preHandler: requirePermission('affiliates.payouts.manage') }, async (request) => {
      const { payoutId } = z.object({ payoutId: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      await failPayout(db, payoutId, actorFromRequest(request), b.reason);
      return { ok: true };
    });
    // Marking PAID moves money and requires a FINANCIAL step-up + evidence (§65).
    app.post('/affiliates/payouts/:payoutId/pay', { preHandler: [requirePermission('affiliates.payouts.manage'), requireReauth('FINANCIAL')] }, async (request) => {
      const { payoutId } = z.object({ payoutId: z.string().uuid() }).parse(request.params);
      const b = z.object({ externalReference: z.string().min(3).max(200), method: z.string().min(2).max(40), evidenceRef: z.string().max(200).optional() }).parse(request.body);
      await markPayoutPaid(db, payoutId, { externalReference: b.externalReference, method: b.method, evidenceRef: b.evidenceRef, actor: actorFromRequest(request) });
      return { ok: true };
    });

    // Program configuration — owner-tier + FINANCIAL step-up (financial config).
    app.get('/affiliates/config', { preHandler: requirePermission('affiliates.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return getAffiliateConfig(db, org);
    });
    app.post('/affiliates/config', { preHandler: [requirePermission('affiliates.config.manage'), requireReauth('FINANCIAL')] }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.record(z.string(), z.unknown()).parse(request.body ?? {});
      return updateAffiliateConfig(db, org, b as never, actorFromRequest(request));
    });

    // Maintenance jobs (run maturity + tier recalculation on demand).
    app.post('/affiliates/jobs/mature', { preHandler: requirePermission('affiliates.manage') }, async () => {
      const org = await defaultOrganizationId(db);
      return { matured: await matureCommissions(db, org) };
    });
    app.post('/affiliates/jobs/recalc-tiers', { preHandler: requirePermission('affiliates.manage') }, async () => {
      const org = await defaultOrganizationId(db);
      return { changed: await recalcAllTiers(db, org) };
    });
  };
}
