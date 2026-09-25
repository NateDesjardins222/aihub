/**
 * Owner Operating System — staff & access management, reauth, impersonation
 * (M10-B). Mounted under /api/v1/admin with granular `requirePermission` gates.
 * A separate public surface (/api/v1/staff-onboarding) lets an invited staff
 * member accept their invitation and set their own password.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireAnyPermission, requireReauth, actorFromRequest } from '../owner-plugin.js';
import { ApiError } from '../errors.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { PERMISSIONS, PERMISSION_GROUPS } from '../../platform/permissions.js';
import { roleDefaults, type Role } from '../../platform/rbac.js';
import {
  acceptInvitation, changeRole, effectiveAccess, inviteStaff, listInvitations, listStaff,
  resendInvitation, revokeInvitation, revokeStaffSessions, setPermissionOverride, setStatus, staffDetail,
} from '../../platform/staff.js';
import { mintStepUp } from '../../platform/reauth.js';
import { REAUTH_CLASSES } from '../../platform/permissions.js';
import { endImpersonation, listActiveImpersonations, startImpersonation } from '../../platform/impersonation.js';

// ============================================================================
// Owner routes — /api/v1/admin
// ============================================================================
export function ownerStaffRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    // ---- reauth (any signed-in operator can step up their own session) ------
    app.post('/security/reauth', async (request) => {
      const b = z.object({ password: z.string().min(1), class: z.enum(REAUTH_CLASSES) }).parse(request.body);
      return mintStepUp(db, request.user!.id, b.password, b.class);
    });

    // ---- my own effective access (used by the web to render nav truthfully) --
    app.get('/me/access', async (request) => {
      const access = await effectiveAccess(db, request.user!.id);
      if (!access) throw ApiError.unauthorized();
      return access;
    });

    // ---- permission catalog -------------------------------------------------
    app.get('/staff/catalog', { preHandler: requirePermission('staff.read') }, async () => ({
      permissions: PERMISSIONS,
      groups: PERMISSION_GROUPS,
      roleDefaults: {
        SUPPORT: roleDefaults('SUPPORT'),
        ADMIN: roleDefaults('ADMIN'),
        SUPER_ADMIN: roleDefaults('SUPER_ADMIN'),
      } satisfies Record<Exclude<Role, 'TRADER'>, string[]>,
    }));

    // ---- staff listing / detail --------------------------------------------
    app.get('/staff', { preHandler: requirePermission('staff.read') }, async () => ({
      staff: await listStaff(db),
      invitations: await listInvitations(db),
    }));

    app.get('/staff/:id', { preHandler: requirePermission('staff.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return staffDetail(db, id);
    });

    // ---- invitations (staff.manage + STAFF reauth) --------------------------
    app.post('/staff/invite', { preHandler: [requirePermission('staff.manage'), requireReauth('STAFF')] }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({
        email: z.string().email(),
        displayName: z.string().max(60).optional(),
        role: z.enum(['SUPPORT', 'ADMIN', 'SUPER_ADMIN']),
        permissions: z.array(z.object({ permission: z.string(), effect: z.enum(['GRANT', 'DENY']) })).optional(),
      }).parse(request.body);
      const result = await inviteStaff(db, {
        organizationId: org,
        email: b.email,
        displayName: b.displayName,
        role: b.role,
        permissions: b.permissions,
        invitedByUserId: request.user!.id,
        actor: actorFromRequest(request),
      });
      // The activation token is returned ONCE to the creating operator (and would
      // also be delivered via the notification seam). It is never stored in clear.
      return { invitationId: result.invitationId, activationToken: result.token, expiresAt: result.expiresAt };
    });

    app.post('/staff/invitations/:id/resend', { preHandler: requirePermission('staff.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const r = await resendInvitation(db, id, actorFromRequest(request));
      return { activationToken: r.token, expiresAt: r.expiresAt };
    });

    app.post('/staff/invitations/:id/revoke', { preHandler: requirePermission('staff.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await revokeInvitation(db, id, actorFromRequest(request));
      return { ok: true };
    });

    // ---- role / permissions (roles.manage + STAFF reauth) -------------------
    app.post('/staff/:id/role', { preHandler: [requirePermission('roles.manage'), requireReauth('STAFF')] }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ role: z.enum(['SUPPORT', 'ADMIN', 'SUPER_ADMIN']) }).parse(request.body);
      await changeRole(db, id, b.role, actorFromRequest(request));
      return staffDetail(db, id);
    });

    app.post('/staff/:id/permission', { preHandler: requirePermission('roles.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ permission: z.string().min(1), effect: z.enum(['GRANT', 'DENY', 'CLEAR']) }).parse(request.body);
      await setPermissionOverride(db, id, b.permission, b.effect, actorFromRequest(request));
      return staffDetail(db, id);
    });

    // ---- lifecycle (staff.manage) ------------------------------------------
    app.post('/staff/:id/suspend', { preHandler: requirePermission('staff.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await setStatus(db, id, 'DISABLED', actorFromRequest(request), 'staff.suspended');
      return staffDetail(db, id);
    });

    app.post('/staff/:id/disable', { preHandler: [requirePermission('staff.manage'), requireReauth('STAFF')] }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await setStatus(db, id, 'DISABLED', actorFromRequest(request), 'staff.disabled');
      return staffDetail(db, id);
    });

    app.post('/staff/:id/reactivate', { preHandler: requirePermission('staff.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await setStatus(db, id, 'ACTIVE', actorFromRequest(request), 'staff.reactivated');
      return staffDetail(db, id);
    });

    app.post('/staff/:id/revoke-sessions', { preHandler: requirePermission('security.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const revoked = await revokeStaffSessions(db, id, actorFromRequest(request));
      return { revoked };
    });

    // ---- impersonation ------------------------------------------------------
    app.post('/customers/:userId/impersonate', { preHandler: requirePermission('customers.impersonate') }, async (request) => {
      const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
      const b = z.object({ reason: z.string().min(3), mode: z.enum(['READ_ONLY', 'SUPPORT']).optional() }).parse(request.body);
      const org = await defaultOrganizationId(db);
      const r = await startImpersonation(db, {
        organizationId: org,
        operatorUserId: request.user!.id,
        targetUserId: userId,
        reason: b.reason,
        mode: b.mode,
        actor: actorFromRequest(request),
        ip: request.ip,
        requestId: request.id,
      });
      return { sessionId: r.sessionId, supportToken: r.token, expiresAt: r.expiresAt, mode: b.mode ?? 'READ_ONLY' };
    });

    app.get('/impersonation/active', { preHandler: requirePermission('customers.read') }, async () => ({
      sessions: await listActiveImpersonations(db),
    }));

    app.post('/impersonation/:id/end', { preHandler: requirePermission('customers.impersonate') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await endImpersonation(db, id, actorFromRequest(request));
      return { ok: true };
    });

    // ---- security overview --------------------------------------------------
    app.get('/security/overview', { preHandler: requireAnyPermission('security.manage', 'audit.read') }, async () => ({
      activeImpersonations: await listActiveImpersonations(db),
    }));
  };
}

// ============================================================================
// Public staff onboarding — /api/v1/staff-onboarding (no session auth)
// ============================================================================
export function staffOnboardingRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();

    // Peek at an invitation by token (email + role only; nothing sensitive).
    app.get('/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
      const { token } = z.object({ token: z.string().min(10) }).parse(request.params);
      const { hashToken } = await import('../../platform/staff.js');
      const { staffInvitations } = await import('../../db/schema.js');
      const { eq } = await import('drizzle-orm');
      const [inv] = await db
        .select({ email: staffInvitations.email, role: staffInvitations.role, status: staffInvitations.status, expiresAt: staffInvitations.expiresAt, displayName: staffInvitations.displayName })
        .from(staffInvitations)
        .where(eq(staffInvitations.tokenHash, hashToken(token)));
      if (!inv) throw ApiError.notFound('INVITE_NOT_FOUND', 'Invitation is invalid.');
      const valid = inv.status === 'INVITED' && inv.expiresAt.getTime() > Date.now();
      return { email: inv.email, role: inv.role, displayName: inv.displayName, valid, status: inv.status };
    });

    app.post('/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
      const b = z.object({ token: z.string().min(10), password: z.string().min(10), displayName: z.string().max(60).optional() }).parse(request.body);
      const r = await acceptInvitation(db, { token: b.token, password: b.password, displayName: b.displayName });
      return { ok: true, email: r.email, role: r.role };
    });
  };
}
