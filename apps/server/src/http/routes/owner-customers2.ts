/**
 * Owner OS Customer Directory + tags + 360 aggregation (M10-D). Mounted at
 * /api/v1/admin/ops (the existing OCC customer console stays at /api/v1/admin).
 * Server-side pagination and computed columns; tags gate on customers.tags.write.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, actorFromRequest } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { addTag, customerDirectory, listTags, removeTag } from '../../platform/customer-directory.js';
import { explainObject } from '../../platform/object-explorer.js';

export function ownerCustomerRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    app.get('/directory', { preHandler: requirePermission('customers.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ query: z.string().optional(), segment: z.enum(['funded', 'five_active', 'never_traded', 'paid_out']).optional(), cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query ?? {});
      return customerDirectory(db, org, q);
    });

    app.get('/customers/:userId/360', { preHandler: requirePermission('customers.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
      const view = await explainObject(db, org, 'customer', userId);
      const tags = await listTags(db, userId);
      return { ...view, tags };
    });

    app.get('/customers/:userId/tags', { preHandler: requirePermission('customers.read') }, async (request) => {
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
      return { tags: await listTags(db, userId) };
    });

    app.post('/customers/:userId/tags', { preHandler: requirePermission('customers.tags.write') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
      const b = z.object({ tag: z.string().min(1).max(40) }).parse(request.body);
      await addTag(db, org, userId, b.tag, actorFromRequest(request));
      return { tags: await listTags(db, userId) };
    });

    app.delete('/customers/:userId/tags/:tag', { preHandler: requirePermission('customers.tags.write') }, async (request) => {
      const { userId, tag } = z.object({ userId: z.string().uuid(), tag: z.string().min(1) }).parse(request.params);
      await removeTag(db, userId, tag, actorFromRequest(request));
      return { tags: await listTags(db, userId) };
    });
  };
}
