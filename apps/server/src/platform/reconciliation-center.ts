/**
 * Reconciliation Center (M10-G): aggregates reconciliation health across systems
 * from the authoritative tables (trading provider runs, payout reconciliation,
 * execution reconciliation state, commerce/provisioning exceptions). Read-only.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { payoutReconciliationRecords, providerReconciliationRuns, reconciliationState } from '../db/schema.js';
import { exceptionCounts } from './owner-customer.js';

export interface ReconSystem {
  readonly system: string;
  readonly lastRunAt: string | null;
  readonly matched: number;
  readonly mismatch: number;
  readonly unknown: number;
  readonly ageHours: number | null;
  readonly status: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'EMPTY';
}

function ageHours(d: Date | null | undefined): number | null {
  return d ? (Date.now() - new Date(d).getTime()) / 3_600_000 : null;
}

export async function reconciliationCenter(db: Database, organizationId: string): Promise<{ systems: ReconSystem[]; openMismatches: number }> {
  const systems: ReconSystem[] = [];

  // Trading provider reconciliation runs (M9).
  const [tr] = await db
    .select({ latest: sql<Date | null>`max(${providerReconciliationRuns.createdAt})`, matched: sql<number>`coalesce(sum(${providerReconciliationRuns.matched}),0)::int`, mismatch: sql<number>`coalesce(sum(${providerReconciliationRuns.mismatch}),0)::int`, unknown: sql<number>`coalesce(sum(${providerReconciliationRuns.unknown}),0)::int` })
    .from(providerReconciliationRuns);
  systems.push({ system: 'TRADING_PROVIDER', lastRunAt: tr?.latest ? new Date(tr.latest).toISOString() : null, matched: Number(tr?.matched ?? 0), mismatch: Number(tr?.mismatch ?? 0), unknown: Number(tr?.unknown ?? 0), ageHours: ageHours(tr?.latest), status: !tr?.latest ? 'EMPTY' : Number(tr?.mismatch ?? 0) > 0 ? 'WARNING' : 'HEALTHY' });

  // Payout provider reconciliation records (M8).
  const [pr] = await db
    .select({ latest: sql<Date | null>`max(${payoutReconciliationRecords.createdAt})`, mismatch: sql<number>`count(*) filter (where ${payoutReconciliationRecords.mismatchType} <> 'NONE' and ${payoutReconciliationRecords.autoResolved} = false)::int`, matched: sql<number>`count(*) filter (where ${payoutReconciliationRecords.mismatchType} = 'NONE')::int` })
    .from(payoutReconciliationRecords);
  systems.push({ system: 'PAYOUT_PROVIDER', lastRunAt: pr?.latest ? new Date(pr.latest).toISOString() : null, matched: Number(pr?.matched ?? 0), mismatch: Number(pr?.mismatch ?? 0), unknown: 0, ageHours: ageHours(pr?.latest), status: !pr?.latest ? 'EMPTY' : Number(pr?.mismatch ?? 0) > 0 ? 'WARNING' : 'HEALTHY' });

  // Execution reconciliation state (M4): accounts requiring reconciliation / unknown.
  const [ex] = await db
    .select({ required: sql<number>`count(*) filter (where ${reconciliationState.state} = 'RECONCILIATION_REQUIRED')::int`, unknown: sql<number>`count(*) filter (where ${reconciliationState.state} = 'UNKNOWN')::int`, insync: sql<number>`count(*) filter (where ${reconciliationState.state} = 'IN_SYNC')::int`, latest: sql<Date | null>`max(${reconciliationState.lastCheckedAt})` })
    .from(reconciliationState);
  const exMismatch = Number(ex?.required ?? 0);
  const exUnknown = Number(ex?.unknown ?? 0);
  systems.push({ system: 'EXECUTION', lastRunAt: ex?.latest ? new Date(ex.latest).toISOString() : null, matched: Number(ex?.insync ?? 0), mismatch: exMismatch, unknown: exUnknown, ageHours: ageHours(ex?.latest), status: exMismatch + exUnknown === 0 ? (ex?.latest ? 'HEALTHY' : 'EMPTY') : exMismatch > 0 ? 'WARNING' : 'HEALTHY' });

  // Commerce / provisioning exceptions.
  const counts = await exceptionCounts(db, organizationId).catch(() => ({} as Record<string, number>));
  const provEx = Number((counts as Record<string, number>)['provisioning'] ?? (counts as Record<string, number>)['provisioningExceptions'] ?? 0);
  systems.push({ system: 'COMMERCE_PROVISIONING', lastRunAt: null, matched: 0, mismatch: provEx, unknown: 0, ageHours: null, status: provEx > 0 ? 'CRITICAL' : 'HEALTHY' });

  const openMismatches = systems.reduce((n, s) => n + s.mismatch + s.unknown, 0);
  return { systems, openMismatches };
}

void and;
void eq;
void desc;
