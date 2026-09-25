/**
 * Owner OS alerts + incidents + notification channels (M10-H). Mounted at
 * /api/v1/admin/ops. Alerts coalesce by dedupe key; incidents group alerts;
 * external SMS/push report NOT_CONFIGURED truthfully and are never faked.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { requireUser } from '../auth-plugin.js';
import { requirePermission, requireAnyPermission, actorFromRequest } from '../owner-plugin.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { acknowledgeAlert, alertSummary, listAlerts, listSubscriptions, notificationChannels, raiseAlert, resolveAlert, setSubscription } from '../../platform/alerts.js';
import { INCIDENT_STATUSES, assignIncident, incidentDetail, incidentSummary, listIncidents, openOrGroupIncident, transitionIncident, type IncidentStatus } from '../../platform/incidents.js';

export function ownerAlertRoutes() {
  return async (app: FastifyInstance): Promise<void> => {
    const { db } = getDb();
    app.addHook('preHandler', requireUser);

    // ---- alerts -------------------------------------------------------------
    app.get('/alerts', { preHandler: requirePermission('alerts.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ status: z.string().optional(), severity: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query ?? {});
      return { alerts: await listAlerts(db, org, q), summary: await alertSummary(db, org) };
    });

    app.post('/alerts/:id/ack', { preHandler: requirePermission('alerts.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await acknowledgeAlert(db, id, actorFromRequest(request));
      return { ok: true };
    });

    app.post('/alerts/:id/resolve', { preHandler: requirePermission('alerts.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await resolveAlert(db, id, actorFromRequest(request));
      return { ok: true };
    });

    app.get('/alerts/channels', { preHandler: requirePermission('alerts.read') }, async () => ({ channels: notificationChannels() }));

    app.get('/alerts/subscriptions', { preHandler: requirePermission('alerts.read') }, async (request) => ({
      subscriptions: await listSubscriptions(db, request.user!.id),
    }));

    app.post('/alerts/subscriptions', { preHandler: requirePermission('alerts.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ channel: z.enum(['IN_APP', 'EMAIL', 'SMS', 'PUSH']), minSeverity: z.enum(['INFO', 'NOTICE', 'WARNING', 'CRITICAL', 'EMERGENCY']).optional(), enabled: z.boolean().optional(), categories: z.array(z.string()).optional() }).parse(request.body);
      await setSubscription(db, { organizationId: org, userId: request.user!.id, ...b });
      return { ok: true };
    });

    // ---- incidents ----------------------------------------------------------
    app.get('/incidents', { preHandler: requireAnyPermission('system.incidents.manage', 'system.read') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(request.query ?? {});
      return { incidents: await listIncidents(db, org, q), summary: await incidentSummary(db, org) };
    });

    app.post('/incidents', { preHandler: requirePermission('system.incidents.manage') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ title: z.string().min(3), severity: z.enum(['INFO', 'WARNING', 'CRITICAL', 'EMERGENCY']).optional(), source: z.string().optional(), affectedSubsystem: z.string().optional(), dedupeKey: z.string().optional() }).parse(request.body);
      return openOrGroupIncident(db, { organizationId: org, actor: actorFromRequest(request), ...b });
    });

    app.get('/incidents/:id', { preHandler: requireAnyPermission('system.incidents.manage', 'system.read') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      return incidentDetail(db, id);
    });

    app.post('/incidents/:id/transition', { preHandler: requirePermission('system.incidents.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ to: z.enum(INCIDENT_STATUSES), note: z.string().optional() }).parse(request.body);
      await transitionIncident(db, id, b.to as IncidentStatus, actorFromRequest(request), b.note);
      return incidentDetail(db, id);
    });

    app.post('/incidents/:id/assign', { preHandler: requirePermission('system.incidents.manage') }, async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const b = z.object({ assigneeUserId: z.string().uuid() }).parse(request.body);
      await assignIncident(db, id, b.assigneeUserId, actorFromRequest(request));
      return { ok: true };
    });

    // Manual alert raise (owner-initiated), useful for drills; also gated.
    app.post('/alerts', { preHandler: requirePermission('alerts.manage') }, async (request) => {
      const org = await defaultOrganizationId(db);
      const b = z.object({ severity: z.enum(['INFO', 'NOTICE', 'WARNING', 'CRITICAL', 'EMERGENCY']), category: z.string().min(1), title: z.string().min(1), body: z.string().optional(), dedupeKey: z.string().optional() }).parse(request.body);
      return raiseAlert(db, { organizationId: org, source: 'owner-console', ...b });
    });
  };
}
