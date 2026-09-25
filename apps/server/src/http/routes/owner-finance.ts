/**
 * Owner OS financial operations, money trace, exports, saved views, notes,
 * tasks, agreements (M10-J). Mounted at /api/v1/admin/ops.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, actorFromRequest } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { agreementCenter, financialSummary, payoutMoneyTrace } from '../../platform/financial-ops.js';
import {
  EXPORT_KINDS, addNote, createExportJob, createTask, deleteView, getExport, listExports, listNotes,
  listTasks, listViews, pinNote, saveView, updateTask,
} from '../../platform/ops-workspace.js';

export function ownerFinanceRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    app.get('/finance/summary', { preHandler: requirePermission('finance.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return financialSummary(db, org);
    });

    app.get('/finance/money-trace/payout/:id', { preHandler: requirePermission('finance.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return payoutMoneyTrace(db, id);
    });

    app.get('/agreements', { preHandler: requirePermission('customers.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return agreementCenter(db, org);
    });

    // ---- exports ------------------------------------------------------------
    app.post('/exports', { preHandler: requirePermission('exports.run') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ kind: z.enum(EXPORT_KINDS), filters: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
      return createExportJob(db, { organizationId: org, kind: b.kind, filters: b.filters, actor: actorFromRequest(request) });
    });
    app.get('/exports', { preHandler: requirePermission('exports.run') }, async () => {
      const org = await defaultOrganizationId(db);
      return { exports: await listExports(db, org) };
    });
    app.get('/exports/:id', { preHandler: requirePermission('exports.run') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return getExport(db, id);
    });

    // ---- saved views --------------------------------------------------------
    app.get('/views', { preHandler: requirePermission('customers.read') }, async (request) => {
      const q = z.object({ scope: z.string().min(1) }).parse(request.query ?? {});
      return { views: await listViews(db, q.scope, request.user!.id) };
    });
    app.post('/views', { preHandler: requirePermission('customers.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ scope: z.string().min(1), name: z.string().min(1), filters: z.record(z.string(), z.unknown()), visibility: z.enum(['PERSONAL', 'TEAM']).optional() }).parse(request.body);
      return saveView(db, { organizationId: org, ownerUserId: request.user!.id, ...b });
    });
    app.delete('/views/:id', { preHandler: requirePermission('customers.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await deleteView(db, id, request.user!.id);
      return { ok: true };
    });

    // ---- internal notes -----------------------------------------------------
    app.get('/notes/:subjectType/:subjectId', { preHandler: requirePermission('customers.read') }, async (request) => {
      const { subjectType, subjectId } = z.object({ subjectType: z.string(), subjectId: z.string() }).parse(request.params);
      return { notes: await listNotes(db, subjectType, subjectId) };
    });
    app.post('/notes', { preHandler: requirePermission('customers.notes.write') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ subjectType: z.string().min(1), subjectId: z.string().min(1), body: z.string().min(1), pinned: z.boolean().optional() }).parse(request.body);
      return addNote(db, { organizationId: org, actor: actorFromRequest(request), ...b });
    });
    app.post('/notes/:id/pin', { preHandler: requirePermission('customers.notes.write') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ pinned: z.boolean() }).parse(request.body);
      await pinNote(db, id, b.pinned);
      return { ok: true };
    });

    // ---- ops tasks ----------------------------------------------------------
    app.get('/tasks', { preHandler: requirePermission('tasks.read') }, async (request) => {
      const q = z.object({ status: z.string().optional(), mine: z.coerce.boolean().optional() }).parse(request.query ?? {});
      return { tasks: await listTasks(db, { status: q.status, assigneeUserId: q.mine ? request.user!.id : undefined }) };
    });
    app.post('/tasks', { preHandler: requirePermission('tasks.manage') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ title: z.string().min(3), description: z.string().optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(), assigneeUserId: z.string().uuid().optional(), subjectType: z.string().optional(), subjectId: z.string().optional() }).parse(request.body);
      return createTask(db, { organizationId: org, actor: actorFromRequest(request), ...b });
    });
    app.patch('/tasks/:id', { preHandler: requirePermission('tasks.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED']).optional(), assigneeUserId: z.string().uuid().optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional() }).parse(request.body);
      await updateTask(db, id, b);
      return { ok: true };
    });
  };
}
