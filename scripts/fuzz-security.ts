/**
 * Security input fuzzer.
 *
 * Throws thousands of hostile payloads at the validation and parsing surfaces
 * that sit in front of the domain — the request schemas, the Whop webhook
 * verifier and event parser — and asserts the invariant that matters at a trust
 * boundary: hostile input is either cleanly rejected or safely normalised, and
 * NEVER throws an unhandled error (a throw at the edge is a 500, a leaked stack,
 * or a denial-of-service lever) and NEVER pollutes `Object.prototype`.
 *
 * Pure: no database, no server, no network. Run:
 *   pnpm --filter @atlas/server exec tsx ../../scripts/fuzz-security.ts
 *
 * Exit 0 = every payload was handled safely; exit 1 = a payload threw, polluted
 * a prototype, or a forged webhook verified.
 */
import { createHmac } from 'node:crypto';
// Imported by relative path (not the @atlas/* specifier) so this runs from the
// repo root under tsx without depending on a package's node_modules linkage.
import { loginSchema, registerSchema, orderRequestSchema } from '../packages/contracts/src/index.js';
import { verifyStandardWebhook, parseWhopEvent } from '../apps/server/src/platform/whop.js';

let checks = 0;
let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  // eslint-disable-next-line no-console
  console.error(`  ✗ ${msg}`);
};

/** A grab-bag of values that have historically broken naive parsers. */
const HOSTILE_SCALARS: unknown[] = [
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  0,
  -0,
  -1,
  1e308,
  Number.MAX_SAFE_INTEGER + 1,
  '',
  ' ',
  'A'.repeat(100_000),
  '\u0000\u0000',
  '../../etc/passwd',
  "'; DROP TABLE users; --",
  '<script>alert(1)</script>',
  '${jndi:ldap://x}',
  '𝕏'.repeat(1000),
  true,
  false,
  {},
  [],
  { toString: () => { throw new Error('boom'); } },
  Symbol('x') as unknown,
];

/** Objects that attempt prototype pollution through the well-known keys. */
function pollutionPayloads(): unknown[] {
  return [
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
    { __proto__: { polluted: true }, email: 'a@b.co', password: 'x'.repeat(12), displayName: 'z' },
    JSON.parse('{"a":{"__proto__":{"polluted":true}}}'),
  ];
}

function fuzzSchema(name: string, schema: { safeParse: (v: unknown) => { success: boolean } }): void {
  const bodies: unknown[] = [];
  // Scalars in field positions.
  for (const v of HOSTILE_SCALARS) {
    bodies.push(v);
    bodies.push({ email: v, password: v, displayName: v, accountId: v, symbol: v, qty: v, type: v, side: v, clientOrderId: v });
  }
  // Randomised well-shaped-but-hostile bodies.
  for (let i = 0; i < 2000; i += 1) {
    const pick = HOSTILE_SCALARS[i % HOSTILE_SCALARS.length];
    bodies.push({
      email: i % 2 ? pick : `f${i}@atlas.test`,
      password: i % 3 ? pick : 'x'.repeat(12),
      displayName: pick,
      accountId: pick,
      clientOrderId: 'c'.repeat(16),
      symbol: i % 5 ? pick : 'NQ',
      side: i % 7 ? pick : 'BUY',
      qty: i % 4 ? pick : 1,
      type: i % 6 ? pick : 'MARKET',
    });
  }
  for (const body of bodies) {
    checks += 1;
    try {
      const res = schema.safeParse(body);
      if (typeof res.success !== 'boolean') fail(`${name}: safeParse returned non-boolean success`);
    } catch (err) {
      fail(`${name}: threw on a payload: ${(err as Error).message}`);
    }
  }
}

function fuzzPrototypePollution(): void {
  for (const body of pollutionPayloads()) {
    checks += 1;
    registerSchema.safeParse(body);
    orderRequestSchema.safeParse(body);
    parseWhopEvent(body);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const probe = {} as any;
  if (probe.polluted !== undefined) fail('Object.prototype was polluted');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (({} as any).polluted !== undefined) fail('a fresh object inherited a polluted prototype');
}

function fuzzWebhook(): void {
  const secret = 'whsec_' + Buffer.from('a'.repeat(24)).toString('base64');
  // A correctly signed body must verify — otherwise the fuzz proves nothing.
  const id = 'msg_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 'payment.succeeded', data: { metadata: { atlasOrderId: 'o1' } } });
  const key = Buffer.from(secret.split('_')[1] ?? '', 'base64');
  const good = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  checks += 1;
  const okRes = verifyStandardWebhook(body, { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${good}` }, secret);
  if (!okRes.ok) fail('a correctly signed webhook failed to verify');

  // Now every hostile variation must be rejected, never throw, never verify.
  const hostileHeaders: Array<Record<string, string>> = [
    {},
    { 'webhook-id': id },
    { 'webhook-id': id, 'webhook-timestamp': 'not-a-number', 'webhook-signature': `v1,${good}` },
    { 'webhook-id': id, 'webhook-timestamp': '0', 'webhook-signature': `v1,${good}` },
    { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,not-base64!!!' },
    { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${Buffer.from('wrong').toString('base64')}` },
    { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v2,${good}` },
    { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': good },
  ];
  for (const headers of hostileHeaders) {
    checks += 1;
    try {
      const res = verifyStandardWebhook(body, headers, secret);
      if (res.ok) fail(`a forged webhook verified: ${JSON.stringify(headers)}`);
    } catch (err) {
      fail(`webhook verify threw: ${(err as Error).message}`);
    }
  }
  // Tampered body with the original signature must not verify.
  checks += 1;
  const tampered = verifyStandardWebhook(body + 'x', { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${good}` }, secret);
  if (tampered.ok) fail('a tampered body verified against the original signature');

  // parseWhopEvent over hostile payloads never throws.
  for (const v of [...HOSTILE_SCALARS, ...pollutionPayloads()]) {
    checks += 1;
    try {
      parseWhopEvent(v);
    } catch (err) {
      fail(`parseWhopEvent threw: ${(err as Error).message}`);
    }
  }
}

// eslint-disable-next-line no-console
console.log('security fuzz: validation, prototype pollution, webhook verification');
fuzzSchema('registerSchema', registerSchema);
fuzzSchema('loginSchema', loginSchema);
fuzzSchema('orderRequestSchema', orderRequestSchema);
fuzzPrototypePollution();
fuzzWebhook();

// eslint-disable-next-line no-console
console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
