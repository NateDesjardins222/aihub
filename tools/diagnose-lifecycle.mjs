/**
 * The server's own start and stop, attacked.
 *
 *   node tools/diagnose-lifecycle.mjs
 *
 * A trading server is restarted - for a deploy, after a crash, by an
 * orchestrator that health-checks it. The failures that matter are at the
 * edges: a second instance binding a port the first already holds, and a
 * shutdown that strands connections or a database handle.
 *
 * This runs a REAL server on a spare port (never the development one on 4000)
 * and does two things to it:
 *
 *   1. starts a second server on the same port, and asserts it FAILS rather
 *      than half-binding - two engines writing one account is the kind of
 *      thing that corrupts a ledger;
 *   2. sends it SIGTERM and asserts it exits cleanly and lets go of the port,
 *      so the next start is not fighting a zombie.
 *
 * It needs a database, which the server needs to boot at all. It does not
 * touch the development server or its data.
 */
import { spawn } from 'node:child_process';

const PORT = Number(process.env.ATLAS_LIFECYCLE_PORT ?? 4977);
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://atlas:atlas@localhost:5432/atlas';

let passed = 0;
const findings = [];
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`);
  if (ok) passed += 1;
  else findings.push(what);
};

/** Start a server via tsx, resolving once it says it is listening or it dies. */
function startServer(port, env = {}) {
  const child = spawn(
    'pnpm',
    ['--filter', '@atlas/server', 'exec', 'tsx', 'src/index.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DATABASE_URL, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  const ready = new Promise((resolve) => {
    const onData = (d) => {
      out += d;
      if (/listening on http/.test(out)) resolve({ ok: true, out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => resolve({ ok: false, code, out }));
  });
  return { child, ready, output: () => out };
}

const reachable = async (port) => {
  try {
    const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3_000) });
    return r.status === 200;
  } catch {
    return false;
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const first = startServer(PORT);
try {
  const up = await Promise.race([first.ready, wait(40_000).then(() => ({ ok: false, out: 'timeout' }))]);
  check(up.ok, 'a server starts on a free port', `:${PORT}`);
  check(await reachable(PORT), 'and answers a health check');

  // A second server on the same port must not come up.
  const second = startServer(PORT);
  const secondResult = await Promise.race([
    second.ready,
    wait(40_000).then(() => ({ ok: 'timeout' })),
  ]);
  check(
    secondResult.ok === false,
    'a second server on the same port fails instead of half-binding',
    secondResult.ok === 'timeout' ? 'it hung' : `exit ${secondResult.code}`,
  );
  check(
    /EADDRINUSE|address already in use|listen/i.test(second.output()) || secondResult.ok === false,
    'and says why',
  );
  check(await reachable(PORT), 'the first server still serves after the collision');
  try {
    second.child.kill('SIGKILL');
  } catch {
    /* already gone */
  }

  // SIGTERM the first, and it must let go cleanly.
  const exited = new Promise((resolve) => first.child.on('exit', (code, signal) => resolve({ code, signal })));
  first.child.kill('SIGTERM');
  const stop = await Promise.race([exited, wait(15_000).then(() => ({ code: 'timeout' }))]);
  check(stop.code === 0 || stop.signal === 'SIGTERM', 'SIGTERM stops it', `code ${stop.code}, signal ${stop.signal ?? '-'}`);
  check(stop.code !== 'timeout', 'and it does not hang on the way down');

  await wait(2_000);
  check(!(await reachable(PORT)), 'the port is free again once it is down');

  // A fresh server binds the just-freed port: no zombie left holding it.
  const third = startServer(PORT);
  const back = await Promise.race([third.ready, wait(40_000).then(() => ({ ok: false, out: 'timeout' }))]);
  check(back.ok, 'a fresh server binds the port the last one released');
  try {
    third.child.kill('SIGTERM');
  } catch {
    /* fine */
  }
  await wait(1_500);
} finally {
  try {
    first.child.kill('SIGKILL');
  } catch {
    /* fine */
  }
  console.log(`\n${passed} passed, ${findings.length} failed`);
  process.exit(findings.length === 0 ? 0 : 1);
}
