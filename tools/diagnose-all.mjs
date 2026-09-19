/**
 * The master diagnostic run.
 *
 *   pnpm diagnose                 # everything
 *   pnpm diagnose --only fuzz     # one of them
 *   pnpm diagnose --quick         # skip the long ones
 *
 * Every deliberate attempt to break Atlas, in one command, with ONE honest
 * summary at the end. It is the command to run before believing that a change
 * is safe, and it reports what it could not run as clearly as what failed -
 * a suite that was skipped because the server was not up is not a suite that
 * passed.
 *
 * Needs the API on :4000 and the web app on ATLAS_WEB_URL. The unit tests and
 * the mutation run need neither.
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const ONLY = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? null) : null;
const QUICK = argv.includes('--quick');

const API = process.env.ATLAS_API_URL ?? 'http://localhost:4000';
const WEB = process.env.ATLAS_WEB_URL ?? 'http://localhost:5173';

/** `needs` is what has to be up; `slow` is what `--quick` leaves out. */
const RUNS = [
  { id: 'unit', what: 'the unit tests', command: ['pnpm', ['vitest', 'run', '--silent']], needs: [] },
  {
    id: 'mutations',
    what: 'ten deliberate defects, to see whether the tests notice',
    command: ['node', ['tools/diagnose-mutations.mjs']],
    needs: [],
    slow: true,
  },
  {
    id: 'lifecycle',
    what: 'a second server on a held port, and a clean SIGTERM',
    command: ['node', ['tools/diagnose-lifecycle.mjs']],
    needs: [],
    slow: true,
  },
  {
    id: 'authorization',
    what: "a second user attacking the first user's account",
    command: ['node', ['tools/diagnose-authorization.mjs']],
    needs: ['api'],
  },
  {
    id: 'fuzz',
    what: 'malformed, absurd and hostile request bodies',
    command: ['node', ['tools/diagnose-fuzz.mjs']],
    needs: ['api'],
  },
  {
    id: 'multitab',
    what: 'two tabs racing for one session',
    command: ['node', ['tools/diagnose-multitab.mjs']],
    needs: ['api', 'web'],
  },
  {
    id: 'interrupt',
    what: 'a reload, and a dead network, in the middle of an order',
    command: ['node', ['tools/diagnose-interrupt.mjs']],
    needs: ['api', 'web'],
  },
  {
    id: 'chaos',
    what: 'every stored preference corrupted, one at a time and all at once',
    command: ['node', ['tools/diagnose-chaos.mjs']],
    needs: ['api', 'web'],
    slow: true,
  },
  {
    id: 'torture',
    what: 'hundreds of random execution operations against the money invariants',
    command: ['node', ['tools/exec-torture.mjs', '--sequences', '12', '--ops', '10']],
    needs: ['api', 'web'],
    slow: true,
  },
  {
    id: 'browser',
    what: 'every browser suite',
    command: ['node', ['tests/browser/run.mjs']],
    needs: ['api', 'web'],
    slow: true,
  },
];

const reachable = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
    return response.status < 500;
  } catch {
    return false;
  }
};

const up = { api: await reachable(`${API}/health`), web: await reachable(WEB) };
console.log(`API ${up.api ? 'up' : 'DOWN'} at ${API}, web ${up.web ? 'up' : 'DOWN'} at ${WEB}\n`);

const run = (command, args) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ code, output, ms: Date.now() - started }));
    child.on('error', (error) => resolve({ code: -1, output: String(error), ms: Date.now() - started }));
  });

const chosen = RUNS.filter((r) => (ONLY ? r.id.includes(ONLY) : true)).filter(
  (r) => !(QUICK && r.slow),
);

const results = [];
for (const item of chosen) {
  const missing = item.needs.filter((need) => !up[need]);
  if (missing.length > 0) {
    results.push({ ...item, status: 'NOT RUN', detail: `needs ${missing.join(' and ')}` });
    console.log(`SKIP  ${item.id} - needs ${missing.join(' and ')}\n`);
    continue;
  }
  console.log(`---- ${item.id}: ${item.what}`);
  const outcome = await run(item.command[0], item.command[1]);
  const seconds = (outcome.ms / 1000).toFixed(0);
  results.push({
    ...item,
    status: outcome.code === 0 ? 'PASS' : 'FAIL',
    detail: `${seconds}s`,
    output: outcome.output,
  });
  console.log(`     ${outcome.code === 0 ? 'PASS' : 'FAIL'} in ${seconds}s\n`);
  if (outcome.code !== 0) console.log(outcome.output.split('\n').slice(-25).join('\n'));
}

console.log('\n--- diagnostic summary -------------------------------------------\n');
for (const result of results) {
  console.log(`${result.status.padEnd(8)} ${result.id.padEnd(15)} ${result.detail}`);
}

const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'NOT RUN').length;
console.log(
  `\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} not run` +
    (skipped > 0 ? ' - and a suite that did not run is not a suite that passed' : ''),
);
process.exit(failed === 0 ? 0 : 1);
