/**
 * Owner OS System Doctor / Data Integrity / Reconciliation / Full System Test
 * (M10-G). Mounted at /api/v1/admin/ops. All checks are safe and read-only;
 * statuses are truthful (no fake green). Running a sweep is gated by the relevant
 * run permission; viewing history by system.read.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { integrityCheckResults, systemCheckResults } from '../../db/schema.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireAnyPermission } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { runSystemDoctor } from '../../platform/system-doctor.js';
import { runIntegrityChecks } from '../../platform/integrity.js';
import { reconciliationCenter } from '../../platform/reconciliation-center.js';

export function ownerSystemRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    app.get('/system/doctor', { preHandler: requireAnyPermission('system.doctor.run', 'system.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return runSystemDoctor(db, org, true);
    });

    app.get('/system/integrity', { preHandler: requireAnyPermission('system.integrity.run', 'system.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return runIntegrityChecks(db, org, true);
    });

    app.get('/system/reconciliation', { preHandler: requirePermission('system.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return reconciliationCenter(db, org);
    });

    // The "Run Full System Test" (§46): SAFE checks only — never destructive.
    app.post('/system/full-test', { preHandler: requirePermission('system.doctor.run') }, async () => {
      const org = await defaultOrganizationId(db);
      const [doctor, integrity, reconciliation] = await Promise.all([
        runSystemDoctor(db, org, true),
        runIntegrityChecks(db, org, true),
        reconciliationCenter(db, org),
      ]);
      const overall = doctor.overall === 'CRITICAL' || !integrity.ok ? 'CRITICAL' : doctor.overall === 'WARNING' || reconciliation.openMismatches > 0 ? 'WARNING' : 'HEALTHY';
      return { overall, doctor, integrity, reconciliation, at: new Date().toISOString() };
    });

    app.get('/system/results', { preHandler: requirePermission('system.read') }, async (request) => {
      const q = z.object({ kind: z.enum(['doctor', 'integrity']).default('doctor'), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query ?? {});
      const org = await defaultOrganizationId(db);
      if (q.kind === 'integrity') {
        return { results: await db.select().from(integrityCheckResults).where(eq(integrityCheckResults.organizationId, org)).orderBy(desc(integrityCheckResults.createdAt)).limit(q.limit ?? 100) };
      }
      return { results: await db.select().from(systemCheckResults).where(eq(systemCheckResults.organizationId, org)).orderBy(desc(systemCheckResults.createdAt)).limit(q.limit ?? 100) };
    });
  };
}
