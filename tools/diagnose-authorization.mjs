/**
 * Can one trader touch another trader's money?
 *
 *   node tools/diagnose-authorization.mjs
 *
 * This is the attack that matters most, because everything else Atlas gets
 * right is worthless if the answer is yes. A second user is REGISTERED for the
 * occasion - not mocked, not stubbed - and then asked to do every dangerous
 * thing it can think of to the first user's accounts, using ids it should
 * never have been able to use.
 *
 * The rule being tested is simple and absolute: **ownership comes from the
 * token, never from the request body.** A request that names someone else's
 * account must be refused whatever it claims about itself.
 *
 * Every check states what it attempted and what came back. A 2xx anywhere in
 * here is a P0.
 */
const API = process.env.ATLAS_API_URL ?? 'http://localhost:4000';
const VICTIM = { email: 'demo@atlasfutures.local', password: 'atlas-demo-2026' };

let passed = 0;
let failed = 0;
const failures = [];

function check(ok, what, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${what}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${what}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${what}${detail ? `  — ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', token = null, body = null } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  const text = await response.text();
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload };
}

/** Anything that is not a refusal is a finding. */
const refused = (status) => status === 401 || status === 403 || status === 404;

const victim = await call('/api/v1/auth/login', { method: 'POST', body: VICTIM });
if (victim.status !== 200) {
  console.error(`cannot sign in as the victim: ${victim.status}`);
  process.exit(2);
}
const victimToken = victim.body.accessToken;

const accounts = await call('/api/v1/accounts', { token: victimToken });
const victimAccounts = accounts.body?.accounts ?? [];
if (victimAccounts.length === 0) {
  console.error('the victim has no accounts to attack');
  process.exit(2);
}
const target = victimAccounts[0];
console.log(`victim account under attack: ${target.id} (${target.name})\n`);

// A real second user, registered now, with no relationship to the first.
const stamp = Date.now();
const attackerCreds = {
  email: `attacker-${stamp}@atlas.test`,
  password: 'not-a-real-password-2026',
  displayName: 'Attacker',
};
const registered = await call('/api/v1/auth/register', {
  method: 'POST',
  body: attackerCreds,
});
check(
  registered.status === 201 || registered.status === 200,
  'a second user can be registered to attack with',
  `HTTP ${registered.status}`,
);
const attackerToken =
  registered.body?.accessToken ??
  (await call('/api/v1/auth/login', { method: 'POST', body: attackerCreds })).body?.accessToken;
if (!attackerToken) {
  console.error('could not obtain an attacker token');
  process.exit(2);
}

// The attacker's own accounts, for comparison.
const own = await call('/api/v1/accounts', { token: attackerToken });
const ownAccounts = own.body?.accounts ?? [];
check(
  !ownAccounts.some((a) => a.id === target.id),
  "the attacker's own account list does not contain the victim's account",
  `${ownAccounts.length} account(s) of its own`,
);

console.log('\n--- reading what belongs to someone else -------------------------');

for (const [what, path] of [
  ['orders', `/api/v1/orders?accountId=${target.id}`],
  ['positions', `/api/v1/positions?accountId=${target.id}`],
  ['trades', `/api/v1/trades?accountId=${target.id}`],
  ['executions', `/api/v1/executions?accountId=${target.id}`],
  ['the P&L', `/api/v1/accounts/${target.id}/pnl`],
  ['the rule book', `/api/v1/accounts/${target.id}/rules`],
  ['the simulation environment', `/api/v1/accounts/${target.id}/environment`],
]) {
  const result = await call(path, { token: attackerToken });
  check(refused(result.status), `reading ${what} of another user's account is refused`, `HTTP ${result.status}`);
}

console.log('\n--- writing to what belongs to someone else ----------------------');

const attacks = [
  {
    what: "submitting an order on another user's account",
    path: '/api/v1/orders',
    method: 'POST',
    body: {
      accountId: target.id,
      clientOrderId: `attack-${stamp}`,
      symbol: 'NQ',
      side: 'BUY',
      qty: 1,
      type: 'MARKET',
      tif: 'DAY',
    },
  },
  {
    what: "cancelling every order on another user's account",
    path: '/api/v1/orders/cancel-all',
    method: 'POST',
    body: { accountId: target.id },
  },
  {
    what: "flattening another user's position",
    path: '/api/v1/positions/NQ/flatten',
    method: 'POST',
    body: { accountId: target.id },
  },
  {
    what: "reversing another user's position",
    path: '/api/v1/positions/NQ/reverse',
    method: 'POST',
    body: { accountId: target.id },
  },
  {
    what: "attaching protection to another user's position",
    path: '/api/v1/positions/NQ/protect',
    method: 'POST',
    body: { accountId: target.id, stopPrice: 1 },
  },
  {
    what: "resetting another user's account",
    path: `/api/v1/accounts/${target.id}/reset`,
    method: 'POST',
    body: {},
  },
  {
    what: "rewriting another user's risk rules",
    path: `/api/v1/accounts/${target.id}/rules`,
    method: 'PUT',
    body: { maxContracts: 999 },
  },
  {
    what: "rewriting another user's simulation environment",
    path: `/api/v1/accounts/${target.id}/environment`,
    method: 'PUT',
    body: { latencyMs: 0, feesEnabled: false },
  },
];

for (const attack of attacks) {
  const result = await call(attack.path, {
    method: attack.method,
    token: attackerToken,
    body: attack.body,
  });
  check(refused(result.status), `${attack.what} is refused`, `HTTP ${result.status}`);
}

console.log('\n--- with no token at all ----------------------------------------');

for (const [what, path] of [
  ['the account list', '/api/v1/accounts'],
  ["another user's orders", `/api/v1/orders?accountId=${target.id}`],
  ["another user's P&L", `/api/v1/accounts/${target.id}/pnl`],
]) {
  const result = await call(path);
  check(refused(result.status), `${what} needs a token`, `HTTP ${result.status}`);
}

console.log('\n--- with a token that is not a token ----------------------------');

for (const [what, token] of [
  ['a malformed token', 'not-a-jwt'],
  ['an empty token', ''],
  ['a token with a forged payload', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.'],
]) {
  const result = await call('/api/v1/accounts', { token });
  check(refused(result.status), `${what} is refused`, `HTTP ${result.status}`);
}

console.log('\n--- and the victim is untouched ---------------------------------');

const after = await call('/api/v1/accounts', { token: victimToken });
const afterTarget = (after.body?.accounts ?? []).find((a) => a.id === target.id);
check(
  afterTarget !== undefined && afterTarget.balanceMicros === target.balanceMicros,
  "the victim's balance is exactly what it was",
  `${target.balanceMicros} -> ${afterTarget?.balanceMicros}`,
);

const victimOrders = await call(`/api/v1/orders?accountId=${target.id}`, { token: victimToken });
const plantedOrder = (victimOrders.body?.orders ?? []).some((o) =>
  String(o.clientOrderId).startsWith('attack-'),
);
check(!plantedOrder, "no order from the attacker is sitting in the victim's book");

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFINDINGS:');
  for (const line of failures) console.log(`  P0  ${line}`);
}
process.exit(failed === 0 ? 0 : 1);
