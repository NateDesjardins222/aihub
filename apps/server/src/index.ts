/** Server entrypoint. */
import { buildApp } from './http/app.js';
import { env } from './config/env.js';
import { closeDb } from './db/client.js';
import { listInstruments } from '@atlas/instruments';

async function main(): Promise<void> {
  const { app, stack } = await buildApp();

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

  const status = stack.market.getConnectionStatus();
  console.log(`atlas server listening on http://${env().HOST}:${env().PORT}`);
  console.log(
    `market data: provider=${status.providerId} mode=${status.mode} ` +
      `delay=${status.delaySeconds}s state=${status.state}`,
  );
}

main().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
