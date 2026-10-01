/**
 * customer:certify — the customer-system adversarial certification harness.
 *
 * ONE command that re-runs the proofs behind the customer business system and
 * emits a machine-readable verdict. It is the aggregator the hardening phase is
 * certified by: it REUSES the existing deterministic proof suites rather than
 * rebuilding them, and it draws a hard line between what this repository can
 * prove and what it cannot.
 *
 *   INTERNAL SOFTWARE CERTIFIED   — the business logic, state machines, money
 *                                   math, idempotency, ownership isolation and
 *                                   honesty invariants, proven here in code.
 *   EXTERNAL PRODUCTION UNVERIFIED — real Rithmic / Whop-production / payout
 *                                   rail / KYC / object storage / email are NOT
 *                                   connected in this environment and are NOT
 *                                   certified by this harness. Never claimed.
 *
 * Modes:
 *   FAST (default)                 — provider-safety snapshot, a fresh read-only
 *                                    integrity scan, and the fast customer-chain
 *                                    proof suites.
 *   DEEP (CUSTOMER_CERTIFY_DEEP=1) — additionally the heavier concurrency /
 *                                    crash-recovery / torture / soak suites.
 *
 * Flags:
 *   --json   emit a machine-readable JSON report (no vitest output) instead of text.
 *
 * Exit codes:
 *   0  certified (all gates passed)
 *   1  the harness itself failed to run
 *   2  a certification gate FAILED (integrity FAIL, or a proof suite failed)
 *   3  refused — the target looks like PRODUCTION (this harness never certifies prod)
 *
 *   pnpm --filter @atlas/server exec tsx scripts/customer-certify.ts
 *   # or, from the repo root:  pnpm customer:certify
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDb } from '../src/db/client.js';

/** Repo root — this script lives at <root>/apps/server/scripts/. Proof paths and
 *  the vitest config are resolved relative to the root, not the package cwd that
 *  `pnpm --filter` sets. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
import { releaseInfo } from '../src/config/release.js';
import { providerSafetySummary } from '../src/config/provider-safety.js';
import { runIntegrityChecks } from '../src/platform/integrity.js';
import { defaultOrganizationId } from '../src/platform/provisioning.js';

/** Customer-facing provenance invariants the integrity scan must not fail. */
const CUSTOMER_INTEGRITY_KEYS = [
  'INV_STRANDED_PURCHASE',
  'INV_ORPHAN_ACCOUNT',
  'INV_OWNERSHIP_MISMATCH',
  'INV_ACTIVE_ACCOUNTS_PER_IDENTITY',
  'INV_PAID_PAYOUT_HAS_DEBIT',
  'INV_NO_DOUBLE_DEBIT',
];

/**
 * The customer business chain, proven in code. FAST is deterministic and quick;
 * DEEP adds the concurrency / crash / torture / soak suites. Paths are relative
 * to the repo root (the cwd the runner uses).
 */
const FAST_PROOFS = [
  'apps/web/src/state/account-selection.test.ts',       // §4A Portal→Atlas handoff
  'apps/web/src/portal/metric-display.test.ts',         // §4B error ≠ zero
  'apps/server/src/platform/customer-product-integrity.test.ts', // provenance detectors
  'apps/server/src/platform/portal-lifecycle.test.ts',  // portal↔atlas + §4D cap
  'apps/server/src/platform/affiliate-lifecycle.test.ts', // §4C affiliate dedup
  'apps/server/src/platform/golden-path.security.test.ts', // isolation + cap + golden path
  'apps/server/src/platform/recognition.test.ts',       // cert/achievement exactly-once
  'apps/server/src/platform/personal-goals.test.ts',    // progress forge-protection
];
const DEEP_PROOFS = [
  'apps/server/src/platform/commerce-chaos.test.ts',    // one verified payment → one account
  'apps/server/src/platform/account-limit.test.ts',     // 5-active cap under concurrency
  'apps/server/src/platform/payout-ops-torture.test.ts',// payout state machine torture
  'apps/server/src/platform/payout-reversal-crash.test.ts', // reversal crash recovery
  'apps/server/src/platform/resilience-races.test.ts',  // race safety
];

interface ProofGroup { mode: 'FAST' | 'DEEP'; files: string[]; ok: boolean | null }
interface CertifyReport {
  ok: boolean;
  mode: 'FAST' | 'DEEP';
  target: { databaseUrlSafe: string; nodeEnv: string | undefined };
  release: ReturnType<typeof releaseInfo>;
  internalCertified: { integrityOk: boolean; integrity: { key: string; status: string; actual: string }[]; proofs: ProofGroup[] };
  externalUnverified: ReturnType<typeof providerSafetySummary>;
}

/** Redact credentials from a DB URL for the report. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || ''}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

/** Refuse to certify anything that looks like production. */
function productionGuard(url: string): string | null {
  if (process.env['NODE_ENV'] === 'production') return 'NODE_ENV=production';
  const lowered = url.toLowerCase();
  if (/(prod|production)/.test(lowered)) return 'DATABASE_URL names a production database';
  return null;
}

function runProofs(files: string[], json: boolean): boolean {
  try {
    execFileSync('npx', ['vitest', 'run', ...files], {
      cwd: REPO_ROOT,
      stdio: json ? 'pipe' : 'inherit',
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const json = args.has('--json');
  const deep = process.env['CUSTOMER_CERTIFY_DEEP'] === '1';
  const mode: 'FAST' | 'DEEP' = deep ? 'DEEP' : 'FAST';
  const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';

  const refused = productionGuard(url);
  if (refused) {
    const msg = `customer:certify REFUSED — ${refused}. This harness never targets production.`;
    if (json) console.log(JSON.stringify({ ok: false, refused, message: msg }, null, 2));
    else console.error(msg);
    process.exit(3);
  }

  const { db, sql } = createDb(url);
  try {
    const orgId = await defaultOrganizationId(db);
    const report = await runIntegrityChecks(db, orgId, false);
    const customerChecks = report.checks.filter((c) => CUSTOMER_INTEGRITY_KEYS.includes(c.key));
    const integrityOk = customerChecks.every((c) => c.status !== 'FAIL');

    // Proof suites. Integrity must pass before we spend time on the suites.
    const proofGroups: ProofGroup[] = [];
    const fast: ProofGroup = { mode: 'FAST', files: FAST_PROOFS, ok: null };
    proofGroups.push(fast);
    const deepGroup: ProofGroup | null = deep ? { mode: 'DEEP', files: DEEP_PROOFS, ok: null } : null;
    if (deepGroup) proofGroups.push(deepGroup);

    // Close the DB handle before launching vitest (which opens its own).
    await sql.end({ timeout: 5 });

    fast.ok = runProofs(FAST_PROOFS, json);
    if (deepGroup) deepGroup.ok = fast.ok ? runProofs(DEEP_PROOFS, json) : false;

    const proofsOk = proofGroups.every((g) => g.ok === true);
    const ok = integrityOk && proofsOk;

    const out: CertifyReport = {
      ok,
      mode,
      target: { databaseUrlSafe: safeUrl(url), nodeEnv: process.env['NODE_ENV'] },
      release: releaseInfo(),
      internalCertified: {
        integrityOk,
        integrity: customerChecks.map((c) => ({ key: c.key, status: c.status, actual: c.actual })),
        proofs: proofGroups,
      },
      externalUnverified: providerSafetySummary(),
    };

    if (json) console.log(JSON.stringify(out, null, 2));
    else printText(out);
    process.exit(ok ? 0 : 2);
  } catch (err) {
    console.error('customer:certify failed to run:', err);
    try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
    process.exit(1);
  }
}

function printText(r: CertifyReport): void {
  const log = (s = ''): void => { console.log(s); };
  log('== Customer System Certification ==');
  log();
  log(`Mode:     ${r.mode}${r.mode === 'FAST' ? '  (set CUSTOMER_CERTIFY_DEEP=1 for the heavy suites)' : ''}`);
  log(`Target:   ${r.target.databaseUrlSafe}  NODE_ENV=${r.target.nodeEnv ?? '(unset)'}`);
  log(`Build:    commit=${r.release.commit}${r.release.label ? ` label=${r.release.label}` : ''}`);
  log();
  log('-- INTERNAL SOFTWARE CERTIFIED (proven in this repository) --');
  log(`Integrity (customer provenance): ${r.internalCertified.integrityOk ? 'PASS ✓' : 'FAIL ✗'}`);
  for (const c of r.internalCertified.integrity) log(`  ${c.key}: ${c.status} — ${c.actual}`);
  for (const g of r.internalCertified.proofs) {
    log(`Proofs [${g.mode}]: ${g.ok === null ? 'not run' : g.ok ? 'PASS ✓' : 'FAIL ✗'}  (${g.files.length} suites)`);
  }
  log();
  log('-- EXTERNAL PRODUCTION UNVERIFIED (NOT connected, NOT certified here) --');
  for (const p of r.externalUnverified) {
    log(`  ${p.capability}: ${p.mode}${p.safeForProduction ? '' : '  ⚠ not production-connected'} — ${p.detail}`);
  }
  log();
  log(r.ok ? 'RESULT: CUSTOMER SYSTEM CERTIFIED (internal) ✓' : 'RESULT: CERTIFICATION FAILED ✗');
  log('NOTE: internal software certification only — external production providers are not verified by this harness.');
}

main().catch((err) => {
  console.error('customer:certify crashed:', err);
  process.exit(1);
});
