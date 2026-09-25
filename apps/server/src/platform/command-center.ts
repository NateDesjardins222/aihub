/**
 * Command Center (M10-K): the owner landing aggregate. Answers "does Happy Trader
 * need my attention right now?" from real, server-authoritative data — overall
 * health, KPIs, an Attention-Required list (each item links to the real object),
 * recent high-impact admin actions, and a factual daily operations brief.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, auditLog, payoutRequests, users } from '../db/schema.js';
import { financialSummary } from './financial-ops.js';
import { alertSummary } from './alerts.js';
import { incidentSummary } from './incidents.js';
import { jobsSummary } from './ops-io.js';
import { runIntegrityChecks } from './integrity.js';
import { runSystemDoctor } from './system-doctor.js';
import { provisioningExceptionQueue } from './owner-customer.js';
import { supportOverview } from './support-inbox.js';

const ACTIVE = ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED'];

export interface AttentionItem { readonly severity: 'WARNING' | 'CRITICAL'; readonly label: string; readonly link: string; readonly count?: number }

export async function commandCenter(db: Database, organizationId: string) {
  const [doctor, integrity, fin, alerts, incidents, jobs, provisioningExceptions, support] = await Promise.all([
    runSystemDoctor(db, organizationId, false),
    runIntegrityChecks(db, organizationId, false),
    financialSummary(db, organizationId),
    alertSummary(db, organizationId),
    incidentSummary(db, organizationId),
    jobsSummary(db),
    provisioningExceptionQueue(db, organizationId, 100).catch(() => []),
    supportOverview(db, organizationId).catch(() => null),
  ]);

  // KPIs
  const [cust] = await db.select({ total: sql<number>`count(*)::int`, today: sql<number>`count(*) filter (where ${users.createdAt} >= now() - interval '1 day')::int` }).from(users).where(and(eq(users.organizationId, organizationId), eq(users.role, 'TRADER')));
  const acctRows = await db.select({ status: accounts.status, type: accounts.accountType, n: sql<number>`count(*)::int` }).from(accounts).where(eq(accounts.organizationId, organizationId)).groupBy(accounts.status, accounts.accountType);
  const activeFunded = acctRows.filter((r) => r.type === 'FUNDED_SIM' && ACTIVE.includes(r.status)).reduce((n, r) => n + r.n, 0);
  const activeEval = acctRows.filter((r) => r.type !== 'FUNDED_SIM' && ACTIVE.includes(r.status)).reduce((n, r) => n + r.n, 0);
  const [pay] = await db.select({ pending: sql<number>`count(*) filter (where ${payoutRequests.state} in ('REQUESTED','UNDER_REVIEW','APPROVED','PROCESSING'))::int`, paidToday: sql<number>`count(*) filter (where ${payoutRequests.state} = 'PAID' and ${payoutRequests.updatedAt} >= now() - interval '1 day')::int` }).from(payoutRequests).where(eq(payoutRequests.organizationId, organizationId));

  const integrityFailures = integrity.checks.filter((c) => c.status === 'FAIL');

  // Attention Required — every item links to the real object/surface.
  const attention: AttentionItem[] = [];
  if (jobs.deadLetter > 0) attention.push({ severity: 'WARNING', label: `${jobs.deadLetter} dead-letter job(s)`, link: '/admin/ops/jobs?state=dead', count: jobs.deadLetter });
  if (provisioningExceptions.length > 0) attention.push({ severity: 'CRITICAL', label: `${provisioningExceptions.length} paid purchase(s) awaiting provisioning`, link: '/admin/ops/provisioning', count: provisioningExceptions.length });
  if ((alerts.CRITICAL ?? 0) + (alerts.EMERGENCY ?? 0) > 0) attention.push({ severity: 'CRITICAL', label: `${(alerts.CRITICAL ?? 0) + (alerts.EMERGENCY ?? 0)} critical alert(s)`, link: '/admin/ops/alerts?severity=CRITICAL' });
  if (incidents.open > 0) attention.push({ severity: 'WARNING', label: `${incidents.open} open incident(s)`, link: '/admin/ops/incidents' });
  for (const c of integrityFailures) attention.push({ severity: 'CRITICAL', label: `Integrity: ${c.key} (${c.affectedCount})`, link: '/admin/ops/integrity' });
  if (doctor.overall === 'CRITICAL') attention.push({ severity: 'CRITICAL', label: 'System Doctor reports CRITICAL', link: '/admin/ops/doctor' });
  if (support) {
    if (support.breached > 0) attention.push({ severity: 'CRITICAL', label: `${support.breached} support ticket(s) past SLA`, link: '/admin/support', count: support.breached });
    if (support.pendingRemediationApprovals > 0) attention.push({ severity: 'WARNING', label: `${support.pendingRemediationApprovals} remediation(s) awaiting approval`, link: '/admin/support', count: support.pendingRemediationApprovals });
    if (support.unassigned > 0) attention.push({ severity: 'WARNING', label: `${support.unassigned} unassigned support ticket(s)`, link: '/admin/support?view=UNASSIGNED', count: support.unassigned });
  }

  // Recent high-impact admin actions.
  const recentActions = await db
    .select({ id: auditLog.id, action: auditLog.action, actorLabel: auditLog.actorLabel, reason: auditLog.reason, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.organizationId, organizationId), inArray(auditLog.actorType, ['ADMIN'])))
    .orderBy(desc(auditLog.createdAt))
    .limit(15);

  const overall = doctor.overall === 'CRITICAL' || integrityFailures.length > 0 ? 'CRITICAL' : doctor.overall === 'WARNING' || attention.length > 0 ? 'DEGRADED' : 'HEALTHY';

  return {
    overall,
    health: { doctor: doctor.overall, integrityOk: integrity.ok, checks: doctor.checks },
    kpis: {
      totalCustomers: cust?.total ?? 0,
      newCustomersToday: cust?.today ?? 0,
      activeFundedAccounts: activeFunded,
      activeEvaluations: activeEval,
      pendingPayouts: Number(pay?.pending ?? 0),
      payoutsPaidToday: Number(pay?.paidToday ?? 0),
      payoutLiabilityMicros: fin.outstandingPayoutLiabilityMicros,
      paidTraderPayoutMicros: fin.paidTraderPayoutMicros,
      purchaseRevenueMicros: fin.purchaseRevenueMicros,
      openIncidents: incidents.open,
      openCriticalAlerts: (alerts.CRITICAL ?? 0) + (alerts.EMERGENCY ?? 0),
      deadLetterJobs: jobs.deadLetter,
      integrityFailures: integrityFailures.length,
      provisioningExceptions: provisioningExceptions.length,
      openSupportTickets: support?.open ?? 0,
      supportSlaBreached: support?.breached ?? 0,
      pendingRemediationApprovals: support?.pendingRemediationApprovals ?? 0,
      supportCsatAverage: support?.csatAverage ?? 0,
    },
    attention,
    recentActions,
    at: new Date().toISOString(),
  };
}

/** Factual daily operations brief from real system data. */
export async function dailyBrief(db: Database, organizationId: string) {
  const cc = await commandCenter(db, organizationId);
  const k = cc.kpis;
  const lines = [
    `Overall: ${cc.overall}`,
    `${k.newCustomersToday} new customers today`,
    `${k.payoutsPaidToday} payouts paid today`,
    `${k.pendingPayouts} payouts pending`,
    `${k.activeFundedAccounts} active funded accounts`,
    `${k.openIncidents} open incidents`,
    `${k.openCriticalAlerts} critical alerts`,
    `${k.deadLetterJobs} dead-letter jobs`,
    `${k.integrityFailures} integrity failures`,
    `${k.provisioningExceptions} provisioning exceptions`,
  ];
  return { date: new Date().toISOString().slice(0, 10), overall: cc.overall, lines, kpis: k };
}
