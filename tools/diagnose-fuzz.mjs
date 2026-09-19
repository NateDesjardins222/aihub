/**
 * What happens when the API is sent nonsense.
 *
 *   node tools/diagnose-fuzz.mjs
 *
 * Not a security scanner and not a load test: a systematic attempt to make the
 * server answer badly. Every case below is something a broken client, a
 * confused proxy or a malicious user could genuinely send.
 *
 * Three things are checked on every response, and each is its own kind of
 * failure:
 *
 *   1. **It must not be a 5xx.** Malformed input is the client's mistake; a
 *      server that crashes on it has made it its own.
 *   2. **It must not leak.** No stack traces, no file paths, no SQL, no
 *      library names in the body a client receives.
 *   3. **It must not succeed.** A 2xx for `qty: -5` or `qty: NaN` means
 *      something impossible just entered the system.
 *
 * The server is expected to stay up throughout, and that is checked at the end
 * rather than assumed.
 */
const API = process.env.ATLAS_API_URL ?? 'http://localhost:4000';
const CREDS = { email: 'demo@atlasfutures.local', password: 'atlas-demo-2026' };

let passed = 0;
const findings = [];

function check(ok, what, detail = '') {
  if (ok) {
    passed += 1;
  } else {
    findings.push(`${what}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${what}${detail ? `  — ${detail}` : ''}`);
  }
}

/** Anything in a client-visible body that should never be there. */
const LEAKS = [
  /at \/[\w./-]+\.(ts|js):\d+/i, // a stack frame with a real path
  /\/home\/[\w./-]+/, // an absolute path from this machine
  /node_modules/,
  /(select|insert|update|delete)\s+.*\s+from\s+/i, // SQL
  /drizzle|postgres|fastify|zod/i, // library names
  /password|secret|token=/i,
];

async function send(path, { method = 'POST', token = null, raw = null, body = undefined } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(raw !== null ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, text: String(error), ms: Date.now() - started, threw: true };
  }
}

/*
 * Three questions about one response, and `mustRefuse` decides whether the
 * third is asked.
 *
 * Most of what this file sends is garbage, and garbage must be refused. Some
 * of it is merely UNUSUAL - `2e4` is twenty thousand however it is spelled,
 * and `-0` is zero - and a server that accepts those is right to. Demanding a
 * refusal there would be demanding a bug.
 */
function judge(name, result, { mustRefuse = true } = {}) {
  check(result.status !== 0, `${name}: the server answered at all`, result.text?.slice(0, 80));
  check(result.status < 500, `${name}: no 5xx`, `HTTP ${result.status}`);
  if (mustRefuse) {
    check(
      result.status < 200 || result.status >= 300,
      `${name}: was refused rather than accepted`,
      `HTTP ${result.status}`,
    );
  }
  const leak = LEAKS.find((pattern) => pattern.test(result.text ?? ''));
  check(leak === undefined, `${name}: nothing internal leaked`, leak ? `matched ${leak}` : '');
}

const login = await send('/api/v1/auth/login', { body: CREDS });
if (login.status !== 200) {
  console.error(`cannot sign in: ${login.status}`);
  process.exit(2);
}
const token = JSON.parse(login.text).accessToken;
const accounts = JSON.parse(
  (await send('/api/v1/accounts', { method: 'GET', token })).text,
).accounts;
const accountId = accounts[0].id;

console.log(`fuzzing as the demo user, account ${accountId}\n`);

// ---------------------------------------------------------------- the body --

const HUGE = 'x'.repeat(200_000);
const base = {
  accountId,
  clientOrderId: 'fuzz',
  symbol: 'NQ',
  side: 'BUY',
  qty: 1,
  type: 'MARKET',
};

const orderCases = [
  ['no body at all', undefined],
  ['an empty object', {}],
  ['a string instead of an object', 'hello'],
  ['an array instead of an object', [1, 2, 3]],
  ['null', null],
  ['a negative quantity', { ...base, qty: -5 }],
  ['a zero quantity', { ...base, qty: 0 }],
  ['a fractional quantity', { ...base, qty: 1.5 }],
  ['an absurd quantity', { ...base, qty: 1e9 }],
  ['a quantity of Infinity', { ...base, qty: Number.POSITIVE_INFINITY }],
  ['a quantity that is a string', { ...base, qty: '3' }],
  ['a quantity that is a word', { ...base, qty: 'three' }],
  ['a null quantity', { ...base, qty: null }],
  ['a missing quantity', { accountId, clientOrderId: 'f', symbol: 'NQ', side: 'BUY', type: 'MARKET' }],
  ['an unknown side', { ...base, side: 'SIDEWAYS' }],
  ['a lowercase side', { ...base, side: 'buy' }],
  ['an unknown order type', { ...base, type: 'TELEPATHIC' }],
  ['an unknown symbol', { ...base, symbol: 'NOTREAL' }],
  ['an empty symbol', { ...base, symbol: '' }],
  ['a symbol of 200,000 characters', { ...base, symbol: HUGE }],
  ['a client order id of 200,000 characters', { ...base, clientOrderId: HUGE }],
  ['an accountId that is not a uuid', { ...base, accountId: 'not-a-uuid' }],
  ['an accountId that is a uuid nobody owns', { ...base, accountId: '00000000-0000-4000-8000-000000000000' }],
  ['an accountId that is an object', { ...base, accountId: { id: accountId } }],
  ['a limit price of NaN', { ...base, type: 'LIMIT', limitPrice: 'NaN' }],
  ['a limit price of Infinity', { ...base, type: 'LIMIT', limitPrice: 1e400 }],
  ['a negative limit price', { ...base, type: 'LIMIT', limitPrice: -100 }],
  ['a limit order with no limit price', { ...base, type: 'LIMIT' }],
  ['a stop order with no stop price', { ...base, type: 'STOP_MARKET' }],
  ['a price with fifteen decimal places', { ...base, type: 'LIMIT', limitPrice: 20000.123456789012345 }],
  ['prototype pollution in the body', { ...base, __proto__: { admin: true }, constructor: { x: 1 } }],
  ['a deeply nested object', { ...base, bracket: JSON.parse('{"a":'.repeat(80) + '1' + '}'.repeat(80)) }],
];

for (const [name, body] of orderCases) {
  const result = await send('/api/v1/orders', { token, body });
  judge(`order with ${name}`, result);
}

// Malformed JSON, which never reaches the schema at all.
for (const [name, raw] of [
  ['truncated JSON', '{"accountId":'],
  ['JSON with a trailing comma', '{"qty": 1,}'],
  ['a bare newline', '\n'],
  ['NUL bytes', '\u0000\u0000\u0000'],
  ['a 200KB string body', `"${HUGE}"`],
]) {
  const result = await send('/api/v1/orders', { token, raw });
  judge(`order sent as ${name}`, result);
}

// -------------------------------------------------------------- the params --

for (const [name, path] of [
  ['an accountId that is not a uuid', '/api/v1/orders?accountId=nope'],
  ['no accountId at all', '/api/v1/orders'],
  ['an accountId repeated', `/api/v1/orders?accountId=${accountId}&accountId=${accountId}`],
  ['a SQL fragment as the accountId', "/api/v1/orders?accountId=' OR 1=1--"],
  ['a path traversal as the symbol', '/api/v1/positions/..%2F..%2Fetc%2Fpasswd/flatten'],
  ['a 200,000 character query string', `/api/v1/orders?accountId=${HUGE}`],
]) {
  const result = await send(path, { method: 'GET', token });
  check(result.status < 500, `reading with ${name}: no 5xx`, `HTTP ${result.status}`);
  const leak = LEAKS.find((pattern) => pattern.test(result.text ?? ''));
  check(leak === undefined, `reading with ${name}: nothing internal leaked`, leak ? `matched ${leak}` : '');
}

// ------------------------------------------------------------- market data --

for (const [name, path] of [
  ['a negative limit', '/api/v1/marketdata/bars?symbol=NQ&timeframe=1m&limit=-5'],
  ['an enormous limit', '/api/v1/marketdata/bars?symbol=NQ&timeframe=1m&limit=99999999'],
  ['an unknown timeframe', '/api/v1/marketdata/bars?symbol=NQ&timeframe=7s'],
  ['no symbol', '/api/v1/marketdata/bars?timeframe=1m'],
  ['a "before" of NaN', '/api/v1/marketdata/bars?symbol=NQ&timeframe=1m&before=NaN'],
  ['a "before" in the year 300000', '/api/v1/marketdata/bars?symbol=NQ&timeframe=1m&before=9999999999999999'],
]) {
  const result = await send(path, { method: 'GET', token });
  check(result.status < 500, `bars with ${name}: no 5xx`, `HTTP ${result.status}`);
}

// ------------------------------------------ numbers that are not numbers --

/*
 * NaN, Infinity and the numbers next to them, against every route that takes
 * money or a price.
 *
 * The order route was already fuzzed this way. These are the routes that were
 * not, and they are the ones where a bad number is expensive: a protective
 * level is what stands between an account and an unbounded loss, the
 * simulation environment decides how orders fill, and the rules decide when
 * trading stops. `Infinity` cannot survive JSON, but `1e400` parses to it,
 * `-0` is a real value that compares equal to zero, and a number beyond
 * 2^53 stops being the number that was sent.
 */
/*
 * TWO OF THESE ARE LEGITIMATE, AND THIS ROUTE PERSISTS WHAT IT ACCEPTS.
 *
 * A latency of twenty seconds is a legal simulation environment, so the fuzzer
 * would leave the demo account unable to fill anything and every suite that
 * ran afterwards would fail for reasons nothing in it could explain. The
 * environment is read first and written back at the end. Nothing else here
 * changes durable state.
 */
const environmentBefore = await send(`/api/v1/accounts/${accountId}/environment`, {
  method: 'GET',
  token,
});
check(
  environmentBefore.status === 200,
  'the simulation environment can be read before it is abused',
  `HTTP ${environmentBefore.status}`,
);

const NOT_NUMBERS = [
  ['NaN as a string', 'NaN', { mustRefuse: true }],
  ['Infinity written as 1e400', 1e400, { mustRefuse: true }],
  ['negative Infinity written as -1e400', -1e400, { mustRefuse: true }],
  ['beyond the safe integers', 9007199254740993, { mustRefuse: true }],
  ['a number as a string', '20000', { mustRefuse: true }],
  ['a boolean', true, { mustRefuse: true }],
  ['an array', [20000], { mustRefuse: true }],
  ['an object', { valueOf: 20000 }, { mustRefuse: true }],
  // Unusual, not wrong. Accepting these is correct behaviour.
  ['negative zero', -0, { mustRefuse: false }],
  ['a number in exponential notation', 2e4, { mustRefuse: false }],
];

for (const [name, value, how] of NOT_NUMBERS) {
  judge(
    `a stop price that is ${name}`,
    await send('/api/v1/positions/NQ/protect', { token, body: { accountId, stopPrice: value } }),
    how,
  );
  judge(
    `a target price that is ${name}`,
    await send('/api/v1/positions/NQ/protect', { token, body: { accountId, targetPrice: value } }),
    how,
  );
}

// The same, as RAW JSON - `NaN` and `Infinity` are not JSON at all, and a
// parser that accepts them is a parser that will hand one to the engine.
for (const [name, raw] of [
  ['a bare NaN literal', `{"accountId":"${accountId}","stopPrice":NaN}`],
  ['a bare Infinity literal', `{"accountId":"${accountId}","stopPrice":Infinity}`],
  ['a bare -Infinity literal', `{"accountId":"${accountId}","stopPrice":-Infinity}`],
  ['an undefined literal', `{"accountId":"${accountId}","stopPrice":undefined}`],
]) {
  judge(`a stop price sent as ${name}`, await send('/api/v1/positions/NQ/protect', { token, raw }));
}

// The simulation environment: latency, slippage and commission are integers
// with stated bounds, and every one of them changes how money is made.
for (const [name, value, how] of NOT_NUMBERS) {
  judge(
    `a latency of ${name}`,
    await send(`/api/v1/accounts/${accountId}/environment`, {
      method: 'PUT',
      token,
      body: { latencyMs: value },
    }),
    how,
  );
}
for (const [name, patch] of [
  ['a negative latency', { latencyMs: -1 }],
  ['a latency of a day', { latencyMs: 86_400_000 }],
  ['a fractional latency', { latencyMs: 1.5 }],
  ['negative slippage', { marketSlippageTicks: -4 }],
  ['absurd slippage', { marketSlippageTicks: 1e6 }],
  ['a negative commission override', { commissionPerSideMicrosOverride: -1 }],
  ['zero contracts per fill', { maxContractsPerFill: 0 }],
  ['a negative contracts per fill', { maxContractsPerFill: -10 }],
  ['an unknown fill model', { fillModel: 'MAGIC' }],
]) {
  judge(
    `the environment with ${name}`,
    await send(`/api/v1/accounts/${accountId}/environment`, { method: 'PUT', token, body: patch }),
  );
}

// Amending an order: the same numbers, on the route that changes a live one.
for (const [name, value, how] of NOT_NUMBERS.filter((n) => n[2].mustRefuse)) {
  judge(
    `an amend to a quantity of ${name}`,
    await send(`/api/v1/orders/00000000-0000-4000-8000-000000000000?accountId=${accountId}`, {
      method: 'PATCH',
      token,
      body: { qty: value },
    }),
    how,
  );
}

// Put the environment back, and leave no protective level behind.
if (environmentBefore.status === 200) {
  const saved = JSON.parse(environmentBefore.text);
  const restore = await send(`/api/v1/accounts/${accountId}/environment`, {
    method: 'PUT',
    token,
    body: {
      fillModel: saved.fillModel,
      useBarRange: saved.useBarRange,
      intrabarPolicy: saved.intrabarPolicy,
      latencyMs: saved.latencyMs,
      marketSlippageTicks: saved.marketSlippageTicks,
      stopSlippageTicks: saved.stopSlippageTicks,
      maxContractsPerFill: saved.maxContractsPerFill,
      requireThroughTradeForLimit: saved.requireThroughTradeForLimit,
      feesEnabled: saved.feesEnabled,
      commissionPerSideMicrosOverride: saved.commissionPerSideMicrosOverride,
    },
  });
  check(restore.status === 200, 'the simulation environment is put back exactly as it was', `HTTP ${restore.status}`);
  const now = await send(`/api/v1/accounts/${accountId}/environment`, { method: 'GET', token });
  check(
    now.status === 200 && JSON.parse(now.text).latencyMs === saved.latencyMs,
    'and reads back the latency it started with',
  );
}
await send('/api/v1/positions/NQ/protect', {
  token,
  body: { accountId, stopPrice: null, targetPrice: null },
});

// And the account still values. A fuzzer that quietly moved money would be
// the worst possible outcome of running one.
const settled = await send(`/api/v1/accounts/${accountId}/pnl`, { method: 'GET', token });
check(settled.status === 200, 'the account still values after the numeric abuse', `HTTP ${settled.status}`);

// ------------------------------------------------------------ preferences --

for (const [name, body] of [
  ['a preferences blob of 200KB', { junk: HUGE }],
  ['preferences that are an array', [1, 2, 3]],
  ['preferences that are a number', 42],
]) {
  const result = await send('/api/v1/preferences', { method: 'PUT', token, body });
  check(result.status < 500, `preferences as ${name}: no 5xx`, `HTTP ${result.status}`);
}

// ------------------------------------------------------- and it is still up --

const alive = await send('/health', { method: 'GET' });
check(alive.status === 200, 'the server is still alive after all of that', `HTTP ${alive.status}`);

const stillTrading = await send('/api/v1/accounts', { method: 'GET', token });
check(stillTrading.status === 200, 'and still serving real requests', `HTTP ${stillTrading.status}`);

console.log(`\n${passed} checks passed, ${findings.length} finding(s)`);
if (findings.length > 0) {
  console.log('\nFINDINGS:');
  for (const line of findings) console.log(`  ${line}`);
}
process.exit(findings.length === 0 ? 0 : 1);
