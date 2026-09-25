/**
 * Affiliate self-service portal routes (M11). Authenticated; every route is
 * scoped to the caller's OWN affiliate record — an affiliate can never see or act
 * on another affiliate, and never sees referred customers' private data.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { affiliateForUser, acceptAffiliateAgreement, createCampaignCode, currentAffiliateAgreement } from '../../platform/affiliates.js';
import { affiliateDashboard, listConversionsForAffiliate } from '../../platform/affiliate-analytics.js';
import { requestPayout, listPayouts, affiliatePayoutProviderStatus } from '../../platform/affiliate-payouts.js';
import { actorFromRequest } from '../owner-plugin.js';

export function affiliatePortalRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    async function myAffiliate(userId: string) {
      const org = await defaultOrganizationId(db);
      const aff = await affiliateForUser(db, org, userId);
      if (!aff) throw ApiError.notFound('NOT_AN_AFFILIATE', 'You are not enrolled in the partner program.');
      return aff;
    }

    app.get('/me', async (request) => {
      const org = await defaultOrganizationId(db);
      const aff = await affiliateForUser(db, org, request.user!.id);
      if (!aff) return { enrolled: false };
      if (aff.status === 'ACTIVE') return { enrolled: true, ...(await affiliateDashboard(db, aff.id)) };
      // Approved-but-not-activated (or other) → onboarding view.
      return { enrolled: true, onboarding: true, status: aff.status, publicId: aff.publicId };
    });

    app.get('/me/agreement', async () => {
      const org = await defaultOrganizationId(db);
      const a = await currentAffiliateAgreement(db, org);
      return { version: a.version, title: a.title, body: a.body };
    });

    app.post('/me/accept-agreement', async (request) => {
      const aff = await myAffiliate(request.user!.id);
      const res = await acceptAffiliateAgreement(db, aff.id, {
        ip: request.ip, userAgent: request.headers['user-agent'], sessionRef: null, actor: actorFromRequest(request),
      });
      return { status: res.status, code: res.code };
    });

    app.get('/me/conversions', async (request) => {
      const aff = await myAffiliate(request.user!.id);
      return { conversions: await listConversionsForAffiliate(db, aff.id, { limit: 200 }) };
    });

    app.get('/me/payouts', async (request) => {
      const aff = await myAffiliate(request.user!.id);
      return { provider: affiliatePayoutProviderStatus(), payouts: await listPayouts(db, aff.id) };
    });

    app.post('/me/payouts', async (request) => {
      const aff = await myAffiliate(request.user!.id);
      if (aff.status !== 'ACTIVE') throw ApiError.badRequest('NOT_ACTIVE', 'Only active affiliates can request payouts.');
      const b = z.object({ amountMicros: z.number().int().positive() }).parse(request.body);
      return requestPayout(db, { affiliateId: aff.id, amountMicros: b.amountMicros, actor: actorFromRequest(request) });
    });

    app.post('/me/codes', async (request) => {
      const aff = await myAffiliate(request.user!.id);
      if (aff.status !== 'ACTIVE') throw ApiError.badRequest('NOT_ACTIVE', 'Only active affiliates can create codes.');
      const b = z.object({ code: z.string().min(3).max(40), campaignLabel: z.string().max(120).optional() }).parse(request.body);
      // Affiliates create ATTRIBUTION-only campaign codes; discounts are owner-set.
      return createCampaignCode(db, aff.id, b.code, { campaignLabel: b.campaignLabel, actor: actorFromRequest(request) });
    });
  };
}
