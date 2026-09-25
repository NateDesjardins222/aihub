/**
 * System Doctor (M10-G): "is the infrastructure/software operating?"
 *
 * Safe, read-only probes only. Each returns a truthful status; nothing is faked
 * green. Provider checks distinguish configured / not-configured / not-verified —
 * Rithmic in particular is reported as CONFIGURED vs UNCONFIGURED and never as
 * "connected"/"authenticated" from code presence alone (M9 did not complete live
 * acceptance). Market-closed is never reported as a stale-feed CRITICAL.
 *
 * Results persist to `system_check_results` so the console can show history.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { payoutReconciliationRecords, supportTickets, systemCheckResults } from '../db/schema.js';
import { resolveRithmicConnection } from '../infra/rithmic-config.js';
import { affiliatePayoutProviderStatus } from './affiliate-payouts.js';
import { supportStorageStatus } from './support-attachments.js';
import { slaState } from './support-inbox.js';
import { and, eq } from 'drizzle-orm';

export type CheckStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'SUSPICIOUS' | 'NOT_CONFIGURED' | 'NOT_VERIFIED' | 'SKIPPED';

export interface SystemCheck {
  readonly key: string;
  readonly status: CheckStatus;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  readonly expected: string;
  readonly actual: string;
  readonly durationMs: number;
  readonly detail?: Record<string, unknown>;
}

export interface SystemDoctorReport {
  readonly overall: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  readonly runId: string;
  readonly checks: SystemCheck[];
  readonly at: string;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = Date.now();
  const r = await fn();
  return [r, Date.now() - t0];
}

/** DB connectivity + round-trip latency. */
async function checkDatabase(db: Database): Promise<SystemCheck> {
  try {
    const [, ms] = await timed(() => db.execute(sql`select 1 as ok`));
    const status: CheckStatus = ms > 1000 ? 'WARNING' : 'HEALTHY';
    return { key: 'database', status, severity: status === 'WARNING' ? 'WARNING' : 'INFO', expected: 'reachable, < 1s', actual: `reachable, ${ms}ms`, durationMs: ms };
  } catch (e) {
    return { key: 'database', status: 'CRITICAL', severity: 'CRITICAL', expected: 'reachable', actual: `unreachable: ${(e as Error).message.slice(0, 80)}`, durationMs: 0 };
  }
}

/**
 * Migration/schema parity. Verifies the expected latest-migration tables are
 * actually present (schema truth), rather than trusting the migration tracker,
 * which can drift when migrations are applied out of band.
 */
async function checkMigrations(db: Database): Promise<SystemCheck> {
  const sentinels = ['kill_switches', 'incidents', 'alerts', 'staff_invitations', 'admin_adjustments', 'support_tickets', 'support_remediations'];
  try {
    const [rows, ms] = await timed(async () => db.execute(sql`
      select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_name = any(${sql.raw(`array[${sentinels.map((s) => `'${s}'`).join(',')}]`)})
    `));
    const present = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
    const status: CheckStatus = present >= sentinels.length ? 'HEALTHY' : 'CRITICAL';
    return { key: 'migrations', status, severity: status === 'CRITICAL' ? 'CRITICAL' : 'INFO', expected: `${sentinels.length} latest-schema tables present`, actual: `${present}/${sentinels.length} present`, durationMs: ms, detail: { present, expected: sentinels.length } };
  } catch (e) {
    return { key: 'migrations', status: 'WARNING', severity: 'WARNING', expected: 'schema parity verifiable', actual: `could not verify: ${(e as Error).message.slice(0, 80)}`, durationMs: 0 };
  }
}

/** Rithmic status — TRUTHFUL. Configured vs unconfigured; never "connected". */
function checkRithmic(): SystemCheck {
  const r = resolveRithmicConnection();
  if (!r.ok) {
    return { key: 'rithmic', status: 'NOT_CONFIGURED', severity: 'INFO', expected: 'configured for TEST when enabled', actual: `not configured (missing: ${r.missing.join(', ') || 'credentials'})`, durationMs: 0 };
  }
  // Configured, but live authentication/verification is a separate acceptance step.
  return {
    key: 'rithmic',
    status: 'NOT_VERIFIED',
    severity: 'INFO',
    expected: 'authenticated + market/historical/route/execution verified (live acceptance)',
    actual: `configured (${r.connection.environment} @ ${r.connection.systemName}); live acceptance not confirmed in this environment`,
    durationMs: 0,
    detail: { environment: r.connection.environment },
  };
}

/** Payout reconciliation freshness: age of the newest reconciliation record. */
async function checkPayoutReconciliation(db: Database, organizationId: string): Promise<SystemCheck> {
  try {
    const [rows, ms] = await timed(async () => db
      .select({ latest: sql<Date | null>`max(${payoutReconciliationRecords.createdAt})`, mismatches: sql<number>`count(*) filter (where ${payoutReconciliationRecords.mismatchType} <> 'NONE' and ${payoutReconciliationRecords.autoResolved} = false)::int` })
      .from(payoutReconciliationRecords));
    const row = (rows as unknown as Array<{ latest: Date | null; mismatches: number }>)[0];
    const openMismatches = Number(row?.mismatches ?? 0);
    if (!row?.latest) {
      return { key: 'payout_reconciliation', status: 'HEALTHY', severity: 'INFO', expected: 'current or empty', actual: 'no reconciliation records yet', durationMs: ms, detail: { openMismatches } };
    }
    const ageH = (Date.now() - new Date(row.latest).getTime()) / 3_600_000;
    const status: CheckStatus = openMismatches > 0 ? 'WARNING' : ageH > 48 ? 'WARNING' : 'HEALTHY';
    return { key: 'payout_reconciliation', status, severity: status === 'WARNING' ? 'WARNING' : 'INFO', expected: 'recent, no open mismatches', actual: `${ageH.toFixed(1)}h old, ${openMismatches} open mismatch(es)`, durationMs: ms, detail: { openMismatches, ageHours: ageH } };
  } catch {
    void organizationId;
    return { key: 'payout_reconciliation', status: 'SKIPPED', severity: 'INFO', expected: 'reconciliation records', actual: 'not available', durationMs: 0 };
  }
}

/** Paid-but-not-provisioned exceptions — a high-severity operational condition. */
async function checkProvisioning(db: Database): Promise<SystemCheck> {
  try {
    const { provisioningExceptionQueue } = await import('./owner-customer.js');
    const { defaultOrganizationId } = await import('./provisioning.js');
    const org = await defaultOrganizationId(db);
    const [q, ms] = await timed(() => provisioningExceptionQueue(db, org, 100));
    const n = q.length;
    const status: CheckStatus = n > 0 ? 'CRITICAL' : 'HEALTHY';
    return { key: 'provisioning', status, severity: n > 0 ? 'CRITICAL' : 'INFO', expected: 'no paid-but-unprovisioned orders', actual: n > 0 ? `${n} paid order(s) awaiting provisioning` : 'none', durationMs: ms, detail: { count: n } };
  } catch {
    return { key: 'provisioning', status: 'SKIPPED', severity: 'INFO', expected: 'provisioning queue', actual: 'not available', durationMs: 0 };
  }
}

/** Notification / SMS-push providers: honest NOT_CONFIGURED. */
function checkNotificationProvider(): SystemCheck {
  const hasEmail = !!(process.env['RESEND_API_KEY'] || process.env['EMAIL_PROVIDER']);
  const hasSms = !!(process.env['TWILIO_AUTH_TOKEN'] || process.env['SMS_PROVIDER']);
  const actual = `email: ${hasEmail ? 'configured' : 'NOT_CONFIGURED'}, sms/push: ${hasSms ? 'configured' : 'NOT_CONFIGURED'}`;
  return { key: 'notifications', status: hasEmail ? 'HEALTHY' : 'NOT_CONFIGURED', severity: 'INFO', expected: 'at least in-app; external optional', actual, durationMs: 0, detail: { hasEmail, hasSms } };
}

/**
 * Support API reachability + SLA pressure. Reads the ticket table (proving the
 * support surface is live) and reports how many open tickets are past SLA. A
 * breach is a WARNING, never faked green; unreachable is CRITICAL.
 */
async function checkSupport(db: Database, organizationId: string): Promise<SystemCheck> {
  try {
    const [rows, ms] = await timed(async () => db
      .select({ status: supportTickets.status, slaPausedAt: supportTickets.slaPausedAt, resolutionDueAt: supportTickets.resolutionDueAt, resolvedAt: supportTickets.resolvedAt })
      .from(supportTickets)
      .where(and(eq(supportTickets.organizationId, organizationId), sql`${supportTickets.status} not in ('RESOLVED','CLOSED')`))
      .limit(5000));
    const now = new Date();
    const breached = rows.filter((r) => slaState(r, now) === 'BREACHED').length;
    const status: CheckStatus = breached > 0 ? 'WARNING' : 'HEALTHY';
    return { key: 'support', status, severity: breached > 0 ? 'WARNING' : 'INFO', expected: 'reachable, no SLA breaches', actual: `${rows.length} open ticket(s), ${breached} past SLA`, durationMs: ms, detail: { open: rows.length, breached } };
  } catch (e) {
    return { key: 'support', status: 'CRITICAL', severity: 'CRITICAL', expected: 'support surface reachable', actual: `unreachable: ${(e as Error).message.slice(0, 80)}`, durationMs: 0 };
  }
}

/** Support attachment storage — truthful about the active provider (in-process vs object store). */
function checkSupportStorage(): SystemCheck {
  const s = supportStorageStatus();
  return {
    key: 'support_storage', status: 'HEALTHY', severity: 'INFO',
    expected: 'an attachment storage backend', actual: `provider: ${s.provider} (${s.configured ? 'configured' : 'in-process default'})`, durationMs: 0, detail: { provider: s.provider, configured: s.configured },
  };
}

const CRITICAL_STATUSES: CheckStatus[] = ['CRITICAL'];
const WARNING_STATUSES: CheckStatus[] = ['WARNING', 'SUSPICIOUS'];

/** Run the full System Doctor sweep and persist results. */
/** Affiliate payout provider — truthful. NOT_CONFIGURED is informational, not critical. */
function checkAffiliatePayoutProvider(): SystemCheck {
  const s = affiliatePayoutProviderStatus();
  return {
    key: 'affiliate_payouts', status: s.configured ? 'NOT_VERIFIED' : 'NOT_CONFIGURED', severity: 'INFO',
    expected: 'a payout provider when affiliate payouts go live', actual: s.note, durationMs: 0, detail: { provider: s.provider, verified: s.verified },
  };
}

export async function runSystemDoctor(db: Database, organizationId: string, persist = true): Promise<SystemDoctorReport> {
  const runId = randomUUID();
  const checks: SystemCheck[] = [];
  checks.push(await checkDatabase(db));
  checks.push(await checkMigrations(db));
  checks.push(checkRithmic());
  checks.push(await checkPayoutReconciliation(db, organizationId));
  checks.push(await checkProvisioning(db));
  checks.push(checkNotificationProvider());
  checks.push(checkAffiliatePayoutProvider());
  checks.push(await checkSupport(db, organizationId));
  checks.push(checkSupportStorage());

  const overall: SystemDoctorReport['overall'] = checks.some((c) => CRITICAL_STATUSES.includes(c.status))
    ? 'CRITICAL'
    : checks.some((c) => WARNING_STATUSES.includes(c.status))
      ? 'WARNING'
      : 'HEALTHY';

  if (persist) {
    for (const c of checks) {
      await db.insert(systemCheckResults).values({
        organizationId, checkKey: c.key, status: c.status, severity: c.severity,
        expected: c.expected, actual: c.actual, durationMs: c.durationMs, runId, detail: (c.detail ?? null) as never,
      });
    }
  }
  return { overall, runId, checks, at: new Date().toISOString() };
}
