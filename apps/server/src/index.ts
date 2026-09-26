/** Server entrypoint. */
import { buildApp } from './http/app.js';
import { env } from './config/env.js';
import { closeDb, getDb } from './db/client.js';
import { reportLedgerAudit } from './platform/ledger-audit.js';
import { listInstruments } from '@atlas/instruments';
import { reportEgress } from './marketdata/egress.js';
import { providerSafetyLogLines, providerSafetySummary } from './config/provider-safety.js';

async function main(): Promise<void> {
  /*
   * Survive a transient background failure.
   *
   * A long-running server must not die because a background DB consumer (the
   * LISTEN/NOTIFY listener, a worker tick, the valuation loop) saw the database
   * go away for a moment — e.g. during a Postgres restart. Node's default is to
   * crash the process on an unhandled promise rejection; here we log it and stay
   * up. The connection pool reconnects on its own, `/ready` reports 503 in the
   * meantime (so a load balancer stops routing), and `/health` (liveness) stays
   * 200 so an orchestrator does not restart-loop the process. This handler lives
   * in the server entrypoint only — tests build the app directly and never load
   * it — so it never masks an async bug in a test run.
   */
  process.on('unhandledRejection', (reason) => {
    console.error('[reliability] unhandledRejection — kept alive:', reason);
  });

  // Before anything tries to reach the vendor, say whether it can.
  reportEgress();

  const { app, stack, engine } = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env().PORT, host: env().HOST });

  // Bring the feed up and follow every Phase 1 product, so the terminal has
  // data the moment a trader opens any of them.
  await stack.market.start();
  for (const spec of listInstruments()) {
    await stack.market.subscribe(spec.root).catch((err: unknown) => {
      app.log.warn({ err, symbol: spec.root }, 'initial subscribe failed');
    });
  }

  // The engine follows the market only once data is flowing, so a restart does
  // not evaluate stops against an empty quote store.
  await engine.start();

  /*
   * Say whether the books add up.
   *
   * An account's ledger and its product are written by different code paths,
   * and when they disagree the terminal shows figures nobody can reconcile.
   * Reported, never repaired: fixing an account is an administrative act with
   * an audit trail.
   */
  await reportLedgerAudit(getDb().db).catch((err: unknown) => {
    app.log.warn({ err }, 'ledger audit failed');
  });

  const status = stack.market.getConnectionStatus();
  console.log(`atlas server listening on http://${env().HOST}:${env().PORT}`);
  console.log(
    `market data: provider=${status.providerId} mode=${status.mode} ` +
      `delay=${status.delaySeconds}s state=${status.state}`,
  );

  // Provider safety summary — secret-free. Every environment-dependent capability
  // and whether it is a real integration, a development mock, or fail-closed. A
  // production runtime must never print a MOCK here; if it somehow did, the loud
  // warning below makes it impossible to miss in the boot log.
  console.log(`provider safety [runtime=${env().NODE_ENV}]:`);
  for (const line of providerSafetyLogLines()) console.log(line);
  const unsafe = providerSafetySummary().filter((s) => !s.safeForProduction);
  if (unsafe.length > 0) {
    console.warn(
      `WARNING: ${unsafe.length} capability(ies) are running a MOCK in production: ` +
        unsafe.map((s) => s.capability).join(', ') +
        '. This must never happen — a mock must never stand in for a real provider in production.',
    );
  }
}

main().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
