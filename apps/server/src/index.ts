/** Server entrypoint. */
import { buildApp } from './http/app.js';
import { env } from './config/env.js';
import { closeDb } from './db/client.js';

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env().PORT, host: env().HOST });
  // eslint-disable-next-line no-console
  console.log(`atlas server listening on http://${env().HOST}:${env().PORT}`);
}

main().catch((err) => {
  console.error('server failed to start:', err);
  process.exit(1);
});
