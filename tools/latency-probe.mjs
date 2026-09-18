/**
 * The complete latency path, measured, at p50/p95/p99.
 *
 * Opens the terminal, watches a live chart for a while, then reports both
 * halves of the path: the server's (vendor + Atlas) and the browser's (wire,
 * apply, paint). Nothing is simulated - it waits for real observations.
 *
 *   node tools/latency-probe.mjs [SECONDS]
 */
import { launch, signIn, useSymbol } from '../tests/browser/harness.mjs';

const SECONDS = Number(process.argv[2] ?? 180);
const API = process.env.ATLAS_API ?? 'http://localhost:4000';

async function serverReport() {
  const login = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ATLAS_EMAIL ?? 'demo@atlasfutures.local',
      password: process.env.ATLAS_PASSWORD ?? 'atlas-demo-2026',
    }),
  });
  const { accessToken } = await login.json();
  const r = await fetch(`${API}/api/v1/marketdata/latency`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return r.json();
}

const row = (name, s) =>
  `  ${name.padEnd(12)} n=${String(s.count).padStart(4)}  p50 ${String(s.p50).padStart(6)}ms  ` +
  `p95 ${String(s.p95).padStart(6)}ms  p99 ${String(s.p99).padStart(6)}ms  ` +
  `min ${String(s.min).padStart(6)}  max ${String(s.max).padStart(6)}`;

const { browser, page } = await launch({ width: 1680, height: 1050 });
try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await page.click('[data-pane=p1] .chdr-tf:has-text("1m")');
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__atlasLatencyReset?.());
  console.log(`watching a live NQ 1m chart for ${SECONDS}s...`);
  await page.waitForTimeout(SECONDS * 1000);

  const client = await page.evaluate(() => window.__atlasLatency?.() ?? null);
  const server = await serverReport();

  console.log(`\n## server (poll interval ${server.pollIntervalMs}ms)`);
  console.log(`  observations ${server.observations}, untimed ${server.untimed}`);
  console.log(row('vendor', server.vendor), '  <- the feed\'s own delay, not ours');
  console.log(row('normalize', server.normalize));
  console.log(row('publish', server.publish));
  console.log(row('socket', server.socket));
  console.log(row('ATLAS', server.atlas), '  <- the part the server controls');
  console.log(row('total', server.total));

  if (client) {
    console.log(`\n## browser`);
    console.log(`  observations ${client.observations}, unstamped ${client.unstamped}`);
    console.log(row('wire', client.wire));
    console.log(row('apply', client.apply));
    console.log(row('paint', client.paint));
    console.log(row('END TO END', client.endToEnd), '  <- response landing to pixels');
  } else {
    console.log('\n## browser: no report (window.__atlasLatency missing)');
  }
} finally {
  await browser.close();
}
