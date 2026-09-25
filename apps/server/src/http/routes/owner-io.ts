/**
 * Owner OS jobs / webhooks / providers / market-data / execution-quality
 * (M10-I). Mounted at /api/v1/admin/ops. Read-oriented + one safe job retry.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireAnyPermission, actorFromRequest } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import {
  executionQuality, jobsSummary, listJobs, listWebhooks, marketDataIntegrity, providerStatuses, retryJob, webhooksSummary,
} from '../../platform/ops-io.js';

export function ownerIoRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    app.get('/jobs', { preHandler: requireAnyPermission('system.jobs.manage', 'system.read') }, async (request) => {
      const q = z.object({ state: z.enum(['queued', 'dead', 'delivered']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query ?? {});
      return { summary: await jobsSummary(db), jobs: await listJobs(db, q) };
    });

    app.post('/jobs/:id/retry', { preHandler: requirePermission('system.jobs.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await retryJob(db, id, actorFromRequest(request));
      return { ok: true };
    });

    app.get('/webhooks', { preHandler: requireAnyPermission('system.webhooks.manage', 'system.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return { summary: await webhooksSummary(db, org), webhooks: await listWebhooks(db, org) };
    });

    app.get('/providers', { preHandler: requirePermission('system.read') }, async () => ({ providers: await providerStatuses(db) }));

    app.get('/market-data', { preHandler: requirePermission('system.read') }, async () => marketDataIntegrity());

    app.get('/execution-quality', { preHandler: requirePermission('trading.read') }, async (request) => {
      const q = z.object({ sinceHours: z.coerce.number().int().min(1).max(8760).optional() }).parse(request.query ?? {});
      return executionQuality(db, q.sinceHours ?? 720);
    });
  };
}
