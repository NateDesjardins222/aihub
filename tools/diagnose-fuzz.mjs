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

function judge(name, result) {
  check(result.status !== 0, `${name}: the server answered at all`, result.text?.slice(0, 80));
  check(result.status < 500, `${name}: no 5xx`, `HTTP ${result.status}`);
  check(
    result.status < 200 || result.status >= 300,
    `${name}: was refused rather than accepted`,
    `HTTP ${result.status}`,
  );
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
