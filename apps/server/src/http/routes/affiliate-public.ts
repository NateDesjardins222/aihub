/**
 * Public affiliate routes (M11): the program page data, the application intake,
 * referral click tracking and the working agreement text. Rate-limited; no
 * authentication required for apply/click (a logged-in user is linked when present).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { getAffiliateConfig } from '../../platform/affiliate-config.js';
import { submitApplication, currentAffiliateAgreement } from '../../platform/affiliates.js';
import { recordClick } from '../../platform/affiliate-attribution.js';

export function affiliatePublicRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();

    // Public program summary (rates/tiers) — safe, non-sensitive.
    app.get('/program', async () => {
      const org = await defaultOrganizationId(db);
      const cfg = await getAffiliateConfig(db, org);
      return {
        applicationsEnabled: cfg.settings.applicationsEnabled,
        baseRateBps: cfg.settings.tierRatesBps.AFFILIATE,
        tiers: [
          { tier: 'AFFILIATE', rateBps: cfg.settings.tierRatesBps.AFFILIATE, thresholdMicros: cfg.settings.tierThresholdsMicros.AFFILIATE },
          { tier: 'PARTNER', rateBps: cfg.settings.tierRatesBps.PARTNER, thresholdMicros: cfg.settings.tierThresholdsMicros.PARTNER },
          { tier: 'GOLD', rateBps: cfg.settings.tierRatesBps.GOLD, thresholdMicros: cfg.settings.tierThresholdsMicros.GOLD },
          { tier: 'PLATINUM', rateBps: cfg.settings.tierRatesBps.PLATINUM, thresholdMicros: cfg.settings.tierThresholdsMicros.PLATINUM },
        ],
        attributionWindowDays: cfg.settings.attributionWindowDays,
        commissionMaturityDays: cfg.settings.commissionMaturityDays,
        minPayoutMicros: cfg.settings.minPayoutMicros,
      };
    });

    app.get('/agreement', async () => {
      const org = await defaultOrganizationId(db);
      const a = await currentAffiliateAgreement(db, org);
      return { version: a.version, title: a.title, body: a.body, contentHash: a.contentHash };
    });

    // Application intake (rate-limited against spam; §85).
    app.post('/apply', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({
        fullName: z.string().min(2).max(160),
        email: z.string().email().max(200),
        brandName: z.string().max(160).optional(),
        primaryPlatform: z.string().max(60).optional(),
        profileUrl: z.string().max(500).optional(),
        audienceSize: z.string().max(40).optional(),
        audienceDescription: z.string().max(2000).optional(),
        promotionPlan: z.string().max(2000).optional(),
        country: z.string().max(80).optional(),
        extraLinks: z.array(z.string().max(500)).max(10).optional(),
      }).parse(request.body);
      const res = await submitApplication(db, { organizationId: org, userId: request.user?.id ?? null, ...b });
      return reply.code(201).send({ ok: true, affiliateId: res.affiliateId });
    });

    // Referral click tracking (privacy-conscious; first-party session id).
    app.post('/click', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({
        code: z.string().min(1).max(40),
        sessionRef: z.string().min(6).max(80),
        landingPath: z.string().max(400).optional(),
        campaign: z.record(z.string(), z.string()).optional(),
      }).parse(request.body);
      const res = await recordClick(db, { organizationId: org, code: b.code, sessionRef: b.sessionRef, landingPath: b.landingPath, campaign: b.campaign, ip: request.ip, userAgent: request.headers['user-agent'] });
      return { recorded: res.recorded };
    });
  };
}
