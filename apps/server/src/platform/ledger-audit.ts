/**
 * Does every account's money agree with its own rules?
 *
 * An account carries both a ledger (starting balance, balance, high-water
 * mark, drawdown floor) and a product (account size, maximum loss). They are
 * written at different times by different code paths, and when they disagree
 * the terminal shows figures that cannot be reconciled with anything - a
 * $100,000 account whose rules said $150,000 reported "DD LEFT $150.0K",
 * because its floor computed to minus fifty thousand.
 *
 * This runs at start-up and reports. It changes nothing: repairing an account
 * is an administrative act with an audit trail, not something a boot sequence
 * should do quietly.
 */
import { eq } from 'drizzle-orm';
import { accounts } from '../db/schema.js';
import { loadAccountAndTemplate, ruleConfigFor } from '../trading/account-rules.js';
import type { Database } from '../db/client.js';

export interface LedgerFinding {
  readonly accountId: string;
  readonly name: string;
  readonly problem: string;
  readonly ledgerMicros: number;
  readonly expectedMicros: number;
}

/**
 * Every disagreement between an account's ledger and its rules.
 *
 * Deliberately a handful of specific checks rather than a general framework:
 * each one is a way the figures on screen stop making sense.
 */
export async function auditLedgers(db: Database): Promise<LedgerFinding[]> {
  const rows = await db.select({ id: accounts.id }).from(accounts);
  const findings: LedgerFinding[] = [];

  for (const row of rows) {
    const loaded = await loadAccountAndTemplate(db, row.id);
    if (!loaded?.template) continue;
    const account = loaded.account;
    const config = ruleConfigFor(account, loaded.template);

    if (config.accountSizeMicros !== account.startingBalanceMicros) {
      findings.push({
        accountId: row.id,
        name: account.name,
        problem: 'the product size and the starting balance disagree',
        ledgerMicros: account.startingBalanceMicros,
        expectedMicros: config.accountSizeMicros,
      });
    }

    // A floor below zero means the maximum loss exceeds the account, which is
    // either a configuration error or a rule that can never trigger.
    if (config.maxLossMicros > 0 && account.drawdownFloorMicros < 0) {
      findings.push({
        accountId: row.id,
        name: account.name,
        problem: 'the drawdown floor is below zero, so the rule can never trigger',
        ledgerMicros: account.drawdownFloorMicros,
        expectedMicros: Math.max(0, account.startingBalanceMicros - config.maxLossMicros),
      });
    }

    // A high-water mark above the balance with nothing realized to explain it
    // is equity that was marked once and committed - the defect this milestone
    // fixed. Reported so the ones already in the database are visible.
    const realizedRoom = account.balanceMicros - account.startingBalanceMicros;
    if (account.highWaterMarkMicros > account.startingBalanceMicros + Math.max(0, realizedRoom)) {
      findings.push({
        accountId: row.id,
        name: account.name,
        problem: 'the high-water mark is above anything realized P&L can explain',
        ledgerMicros: account.highWaterMarkMicros,
        expectedMicros: account.startingBalanceMicros + Math.max(0, realizedRoom),
      });
    }
  }

  return findings;
}

/** Report the findings on the console at start-up. Never repairs anything. */
export async function reportLedgerAudit(db: Database): Promise<LedgerFinding[]> {
  const findings = await auditLedgers(db);
  if (findings.length === 0) {
    console.log('ledger audit: every account agrees with its own rules');
    return findings;
  }
  console.warn(`ledger audit: ${findings.length} account(s) to look at`);
  for (const f of findings) {
    console.warn(
      `  ${f.name} (${f.accountId}): ${f.problem} — ledger ${(f.ledgerMicros / 1e6).toFixed(2)}, expected ${(f.expectedMicros / 1e6).toFixed(2)}`,
    );
  }
  return findings;
}

/** Used by the admin detail route to show an account's own findings. */
export async function findingsFor(db: Database, accountId: string): Promise<LedgerFinding[]> {
  const all = await auditLedgers(db);
  void eq;
  return all.filter((f) => f.accountId === accountId);
}
