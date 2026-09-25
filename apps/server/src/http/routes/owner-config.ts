/**
 * Owner OS configuration control center (M10-F): feature flags, kill switches,
 * and the config change history. Mounted at /api/v1/admin/ops.
 *
 * Feature-flag writes carry optimistic-concurrency conflict detection. Kill
 * switches require system.kill_switches.manage AND a KILL_SWITCH step-up, and
 * are written to the hash-chained audit log. Product economics keep their own
 * versioned surface (admin products); this center never rewrites applied config.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, like, or } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { auditLog } from '../../db/schema.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireReauth, requireAnyPermission, actorFromRequest } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { KNOWN_FLAGS, listFlags, setFlag } from '../../platform/feature-flags.js';
import { KILL_SWITCHES, engageKillSwitch, isKillSwitchKey, listKillSwitches, releaseKillSwitch } from '../../platform/kill-switches.js';
import { raiseAlert } from '../../platform/alerts.js';

export function ownerConfigRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    // ---- feature flags ------------------------------------------------------
    app.get('/config/flags', { preHandler: requireAnyPermission('system.feature_flags.manage', 'system.read') }, async () => ({
      known: KNOWN_FLAGS,
      flags: await listFlags(db),
    }));

    app.post('/config/flags', { preHandler: requirePermission('system.feature_flags.manage') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({
        key: z.string().min(1).max(60),
        environment: z.string().max(12).optional(),
        enabled: z.boolean(),
        description: z.string().max(500).optional(),
        expectedUpdatedAt: z.string().optional(),
      }).parse(request.body);
      return setFlag(db, { organizationId: org, actor: actorFromRequest(request), ...b });
    });

    // ---- kill switches ------------------------------------------------------
    app.get('/config/kill-switches', { preHandler: requireAnyPermission('system.kill_switches.manage', 'system.read') }, async () => ({
      keys: KILL_SWITCHES,
      switches: await listKillSwitches(db),
    }));

    app.post('/config/kill-switches/:key/engage', { preHandler: [requirePermission('system.kill_switches.manage'), requireReauth('KILL_SWITCH')] }, async (request) => {
      const { key } = z.object({ key: z.string() }).parse(request.params);
      const b = z.object({ reason: z.string().min(3) }).parse(request.body);
      if (!isKillSwitchKey(key)) throw new (await import('../errors.js')).ApiError(400, 'UNKNOWN_SWITCH', `Unknown kill switch ${key}.`);
      const org = await defaultOrganizationId(db);
      await engageKillSwitch(db, key, b.reason, actorFromRequest(request), org);
      // Engaging a kill switch is an emergency control: raise a CRITICAL owner alert.
      await raiseAlert(db, { organizationId: org, severity: 'CRITICAL', category: 'kill_switch', title: `Kill switch engaged: ${key}`, body: b.reason, dedupeKey: `kill_switch:${key}`, source: 'owner-console' });
      return { key, engaged: true };
    });

    app.post('/config/kill-switches/:key/release', { preHandler: [requirePermission('system.kill_switches.manage'), requireReauth('KILL_SWITCH')] }, async (request) => {
      const { key } = z.object({ key: z.string() }).parse(request.params);
      const b = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
      if (!isKillSwitchKey(key)) throw new (await import('../errors.js')).ApiError(400, 'UNKNOWN_SWITCH', `Unknown kill switch ${key}.`);
      const org = await defaultOrganizationId(db);
      await releaseKillSwitch(db, key, b.reason ?? 'released', actorFromRequest(request), org);
      return { key, engaged: false };
    });

    // ---- config change history (reuses the hash-chained audit log) ----------
    app.get('/config/changes', { preHandler: requirePermission('audit.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query ?? {});
      const rows = await db
        .select({ id: auditLog.id, action: auditLog.action, actorLabel: auditLog.actorLabel, subjectId: auditLog.subjectId, prevState: auditLog.prevState, newState: auditLog.newState, reason: auditLog.reason, createdAt: auditLog.createdAt })
        .from(auditLog)
        .where(and(eq(auditLog.organizationId, org), or(like(auditLog.action, 'config.%'), like(auditLog.action, 'kill_switch%'))))
        .orderBy(desc(auditLog.createdAt))
        .limit(q.limit ?? 100);
      return { changes: rows };
    });
  };
}
