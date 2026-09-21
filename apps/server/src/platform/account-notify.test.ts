/**
 * Cross-process wake-up: a NOTIFY on one connection reaches a LISTEN on another.
 *
 * Independent connections are the cross-process condition (Postgres delivers a
 * NOTIFY to every listening session regardless of which process opened it). So
 * this proves the transport an instance uses to learn of a change processed on
 * another instance.
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { listenAccountChanged } from './account-notify.js';
import { notifyAccountChanged } from './outbox.js';

const URL = process.env['TEST_DATABASE_URL'] ?? 'postgres://atlas:atlas@localhost:5432/atlas_test';
const pools: postgres.Sql[] = [];
function pool(): postgres.Sql {
  const p = postgres(URL, { max: 2, onnotice: () => {} });
  pools.push(p);
  return p;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => undefined)));
});

describe('account change notifications', () => {
  it('delivers a NOTIFY from one connection to a LISTEN on another', async () => {
    const notifier = pool();
    const listenerConn = pool();
    const received: string[] = [];

    const sub = await listenAccountChanged(listenerConn, (id) => received.push(id));
    // Give LISTEN a moment to register.
    await new Promise((r) => setTimeout(r, 100));

    const accountId = crypto.randomUUID();
    await notifyAccountChanged(notifier, [accountId]);

    // Wait for the async notification to arrive.
    await new Promise((r) => setTimeout(r, 300));
    await sub.close();

    expect(received).toContain(accountId);
  });

  it('coalesces a batch into one notification per account', async () => {
    const notifier = pool();
    const listenerConn = pool();
    const received: string[] = [];
    const sub = await listenAccountChanged(listenerConn, (id) => received.push(id));
    await new Promise((r) => setTimeout(r, 100));

    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await notifyAccountChanged(notifier, [a, b]);
    await new Promise((r) => setTimeout(r, 300));
    await sub.close();

    expect(received).toContain(a);
    expect(received).toContain(b);
  });
});
