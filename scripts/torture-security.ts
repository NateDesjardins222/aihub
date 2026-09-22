/**
 * Security torture harness.
 *
 * Where the fuzzer asks "does any single payload break a boundary?", this asks
 * "does sustained abuse degrade or crash one?". It drives the trust-boundary
 * surfaces at high volume with hostile input and asserts they stay bounded and
 * never throw: validation, the webhook verifier (constant-time, replay-guarded),
 * password verification against malformed stored hashes, and the WebSocket
 * backpressure decision at extremes.
 *
 * Pure: no database, no server, no network, no secrets. Run:
 *   pnpm --filter @atlas/server exec tsx ../../scripts/torture-security.ts
 *
 * Exit 0 = every round stayed bounded and threw nothing; exit 1 otherwise.
 */
import { createHmac } from 'node:crypto';
import { loginSchema, registerSchema, orderRequestSchema } from '../packages/contracts/src/index.js';
import { verifyStandardWebhook, parseWhopEvent } from '../apps/server/src/platform/whop.js';
import { hashPassword, verifyPassword } from '../apps/server/src/auth/password.js';
import { exceedsBackpressureLimit, MAX_BUFFERED_BYTES } from '../apps/server/src/ws/gateway.js';

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  // eslint-disable-next-line no-console
  console.error(`  ✗ ${msg}`);
};

const HOSTILE: unknown[] = [
  undefined, null, NaN, Infinity, -1, 1e308, '', 'A'.repeat(50_000), '\u0000',
  "'; DROP TABLE users; --", '<script>', { }, [], true,
  JSON.parse('{"__proto__":{"x":1}}'),
];

function rand(): unknown {
  return HOSTILE[Math.floor(Math.random() * HOSTILE.length)];
}

async function tortureValidationAndWebhook(rounds: number): Promise<void> {
  const secret = 'whsec_' + Buffer.from('t'.repeat(24)).toString('base64');
  const start = performance.now();
  let threw = 0;
  for (let i = 0; i < rounds; i += 1) {
    const body = {
      email: rand(), password: rand(), displayName: rand(),
      accountId: rand(), clientOrderId: rand(), symbol: rand(),
      side: rand(), qty: rand(), type: rand(),
    };
    try {
      registerSchema.safeParse(body);
      loginSchema.safeParse(body);
      orderRequestSchema.safeParse(body);
      parseWhopEvent(body);
      verifyStandardWebhook(String(i), {
        'webhook-id': `m${i}`,
        'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
        'webhook-signature': `v1,${Buffer.from(`sig${i}`).toString('base64')}`,
      }, secret);
    } catch {
      threw += 1;
    }
  }
  const ms = performance.now() - start;
  if (threw > 0) fail(`validation/webhook torture threw ${threw} times`);
  // A generous ceiling: this is ~5 operations x rounds of pure CPU work. If it
  // blows past this, something is doing unbounded work per call.
  if (ms > 30_000) fail(`validation/webhook torture too slow: ${ms.toFixed(0)}ms for ${rounds} rounds`);
  // eslint-disable-next-line no-console
  console.log(`  validation+webhook: ${rounds} rounds in ${ms.toFixed(0)}ms, ${threw} throws`);

  // A correctly signed webhook must still verify at the end (the fast path is
  // not broken by the abuse).
  const id = 'ok', ts = String(Math.floor(Date.now() / 1000));
  const b = JSON.stringify({ type: 'payment.succeeded' });
  const key = Buffer.from(secret.split('_')[1] ?? '', 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${b}`).digest('base64');
  const res = verifyStandardWebhook(b, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` }, secret);
  if (!res.ok) fail('a valid webhook failed to verify after the torture run');
}

async function torturePassword(): Promise<void> {
  // Malformed stored hashes must never throw — a corrupt DB row is a failed
  // login, not a 500.
  const malformed = ['', 'x', 'notscrypt', 'a:b:c', '$'.repeat(1000), '\u0000', 'scrypt$bad'];
  for (const stored of malformed) {
    try {
      const ok = await verifyPassword('whatever', stored);
      if (ok !== false) fail(`verifyPassword accepted a malformed stored hash: ${JSON.stringify(stored)}`);
    } catch (err) {
      fail(`verifyPassword threw on malformed stored hash: ${(err as Error).message}`);
    }
  }
  // The real path still works.
  const hash = await hashPassword('a-correct-password');
  if (!(await verifyPassword('a-correct-password', hash))) fail('a correct password failed to verify');
  if (await verifyPassword('a-wrong-password', hash)) fail('a wrong password verified');
  // eslint-disable-next-line no-console
  console.log(`  password: ${malformed.length} malformed hashes rejected without throwing; real path intact`);
}

function tortureBackpressure(): void {
  const cases: Array<[number, boolean]> = [
    [0, false],
    [MAX_BUFFERED_BYTES - 1, false],
    [MAX_BUFFERED_BYTES, false],
    [MAX_BUFFERED_BYTES + 1, true],
    [Number.MAX_SAFE_INTEGER, true],
  ];
  for (const [amount, expected] of cases) {
    if (exceedsBackpressureLimit(amount) !== expected) {
      fail(`backpressure decision wrong at bufferedAmount=${amount}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`  backpressure: decision correct across ${cases.length} extremes (cap ${MAX_BUFFERED_BYTES} bytes)`);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('security torture: sustained abuse of the trust boundaries');
  await tortureValidationAndWebhook(50_000);
  await torturePassword();
  tortureBackpressure();
  // eslint-disable-next-line no-console
  console.log(`\n${failures === 0 ? '✓' : '✗'} ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
