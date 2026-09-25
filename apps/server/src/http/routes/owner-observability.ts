/**
 * Owner OS observability (M10-C): global search, the unified operational event
 * timeline, correlation trace, the universal object explorer and the state/rules
 * inspectors. All read surfaces, granularly authorized; every inspector consumes
 * server-authoritative reason codes rather than re-deriving rules.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { globalSearch } from '../../platform/search.js';
import { queryOpsEvents, correlationTrace } from '../../platform/ops-events.js';
import { explainObject } from '../../platform/object-explorer.js';
import { inspectAccount, inspectPayout } from '../../platform/inspectors.js';
import { commandCenter, dailyBrief } from '../../platform/command-center.js';

export function ownerObservabilityRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    // Command Center: the owner landing aggregate + daily brief.
    app.get('/command-center', { preHandler: requirePermission('system.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return commandCenter(db, org);
    });
    app.get('/daily-brief', { preHandler: requirePermission('system.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return dailyBrief(db, org);
    });

    app.get('/search', { preHandler: requirePermission('customers.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ q: z.string().default('') }).parse(request.query ?? {});
      return globalSearch(db, org, q.q);
    });

    app.get('/events', { preHandler: requirePermission('audit.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({
        stream: z.enum(['ACTIVITY', 'AUDIT', 'SECURITY', 'TECHNICAL']).optional(),
        accountId: z.string().uuid().optional(),
        userId: z.string().uuid().optional(),
        subjectType: z.string().optional(),
        subjectId: z.string().optional(),
        correlationId: z.string().optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }).parse(request.query ?? {});
      return { events: await queryOpsEvents(db, org, q) };
    });

    app.get('/correlation/:id', { preHandler: requirePermission('audit.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      return { correlationId: id, trace: await correlationTrace(db, org, id) };
    });

    app.get('/objects/:type/:id', { preHandler: requirePermission('customers.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const { type, id } = z.object({ type: z.string().min(1), id: z.string().min(1) }).parse(request.params);
      return explainObject(db, org, type, id);
    });

    app.get('/inspect/payout/:id', { preHandler: requirePermission('payouts.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return inspectPayout(db, id);
    });

    app.get('/inspect/account/:id', { preHandler: requirePermission('accounts.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return inspectAccount(db, id);
    });
  };
}
