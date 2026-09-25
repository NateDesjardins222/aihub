/**
 * Owner OS account operations (M10-E). Mounted at /api/v1/admin/ops.
 *
 * Safe, reason-coded, audited account operations: action preview, append-only
 * admin adjustments (NO raw balance edit; accounts.adjust + FINANCIAL reauth),
 * pause/resume/disable/enable (delegating to authoritative account-service), and
 * idempotent provisioning retry for paid-but-not-provisioned exceptions.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireReauth, actorFromRequest } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import {
  ADJUSTMENT_REASON_CODES, applyAdminAdjustment, disableAccountOp, enableAccountOp, listAdjustments,
  pauseAccount, previewAction, resumeAccount, adjustmentNetMicros,
} from '../../platform/account-ops.js';
import { provisioningExceptionQueue } from '../../platform/owner-customer.js';
import { provisionFromEntitlement } from '../../platform/commerce.js';

export function ownerAccountOpsRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    app.get('/accounts/:id/preview', { preHandler: requirePermission('accounts.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { action } = z.object({ action: z.string().min(1) }).parse(request.query ?? {});
      return previewAction(db, id, action, request.user!.id);
    });

    app.get('/accounts/:id/adjustments', { preHandler: requirePermission('accounts.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return { adjustments: await listAdjustments(db, id), net: await adjustmentNetMicros(db, id) };
    });

    // The ONLY financial-correction path. Append-only; elevated + reauthenticated.
    app.post('/accounts/:id/adjust', { preHandler: [requirePermission('accounts.adjust'), requireReauth('FINANCIAL')] }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const org = await defaultOrganizationId(db);
      const b = z.object({
        type: z.enum(['CREDIT', 'DEBIT', 'METADATA']),
        amountMicros: z.number().int().positive().optional(),
        reasonCode: z.enum(ADJUSTMENT_REASON_CODES),
        explanation: z.string().min(5),
        linkedIncidentId: z.string().uuid().optional(),
        linkedCaseId: z.string().uuid().optional(),
      }).parse(request.body);
      return applyAdminAdjustment(db, { organizationId: org, accountId: id, actor: actorFromRequest(request), ...b });
    });

    app.post('/accounts/:id/pause', { preHandler: requirePermission('accounts.pause') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().min(3) }).parse(request.body);
      const row = await pauseAccount(db, id, b.reason, actorFromRequest(request));
      return { id: row.id, status: row.status, adminHold: row.adminHold };
    });

    app.post('/accounts/:id/resume', { preHandler: requirePermission('accounts.pause') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
      const row = await resumeAccount(db, id, b.reason ?? '', actorFromRequest(request));
      return { id: row.id, status: row.status, adminHold: row.adminHold };
    });

    app.post('/accounts/:id/disable', { preHandler: [requirePermission('accounts.pause'), requireReauth('FINANCIAL')] }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().min(3) }).parse(request.body);
      const row = await disableAccountOp(db, id, b.reason, actorFromRequest(request));
      return { id: row.id, status: row.status, adminHold: row.adminHold };
    });

    app.post('/accounts/:id/enable', { preHandler: requirePermission('accounts.pause') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().optional() }).parse(request.body ?? {});
      const row = await enableAccountOp(db, id, b.reason ?? '', actorFromRequest(request));
      return { id: row.id, status: row.status, adminHold: row.adminHold };
    });

    // Provisioning center: list paid-but-not-provisioned, retry idempotently.
    app.get('/provisioning/exceptions', { preHandler: requirePermission('accounts.read') }, async () => {
      const org = await defaultOrganizationId(db);
      return { exceptions: await provisioningExceptionQueue(db, org) };
    });

    app.post('/provisioning/:entitlementId/retry', { preHandler: requirePermission('accounts.provisioning.retry') }, async (request) => {
      const { entitlementId } = z.object({ entitlementId: z.string().uuid() }).parse(request.params);
      const result = await provisionFromEntitlement(db, entitlementId);
      return { accountId: result.accountId, reused: result.reused };
    });
  };
}
