/**
 * How long a trade takes on Atlas, measured end to end.
 *
 *   node tools/exec-latency.mjs                # 40 round trips
 *   node tools/exec-latency.mjs --orders 200   # a longer sample
 *   node tools/exec-latency.mjs --json out.json
 *
 * Each iteration is a real BUY through the real ticket, followed by a real
 * flatten, in a paused recording so the market cannot move the result around.
 * The browser's own instrument (`window.__atlasExecLatency()`) reports the
 * segments; this script drives the clicks and prints the distribution.
 *
 * THE FEED'S DELAY IS NOT IN THESE NUMBERS. The provider is minutes behind and
 * that is a property of the data, not of Atlas. `tools/latency-probe.mjs`
 * measures the feed; this measures the platform.
 */
import { writeFileSync } from 'node:fs';
import { launch, signIn, useAccount, useSymbol, tradableMarket, stepReplay } from '../tests/browser/harness.mjs';

const argv = process.argv.slice(2);
const ORDERS = argv.includes('--orders') ? Number(argv[argv.indexOf('--orders') + 1] ?? 40) : 40;
const JSON_OUT = argv.includes('--json') ? (argv[argv.indexOf('--json') + 1] ?? null) : null;

const { browser, page, errors } = await launch({ width: 1600, height: 950 });

const read = () => page.evaluate(() => window.__atlasExecLatency?.() ?? null);

/** The position line, flattened to one line of text. */
const positionText = () =>
  page
    .textContent('[data-testid=ticket-position]')
    .then((t) => (t ?? '').replace(/\s+/g, ' ').trim())
    .catch(() => '');

try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');

  const market = await tradableMarket(page);
  process.stdout.write(`market: ${market.mode}\n`);

  // One contract, and nothing protective: this measures the round trip, not
  // the bracket machinery.
  await page.click('.tk-preset:text-is("1")');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__atlasExecLatencyReset?.());

  let opened = 0;
  let closed = 0;
  const wall = [];

  for (let i = 0; i < ORDERS; i += 1) {
    const started = Date.now();
    await page.click('[data-testid=buy]');
    await market.fill();
    // The position line is server state: it says the fill happened, not that
    // the click did.
    for (let wait = 0; wait < 20; wait += 1) {
      if (/LONG/.test(await positionText())) break;
      await stepReplay(page, 6);
      await page.waitForTimeout(400);
    }
    if (/LONG/.test(await positionText())) opened += 1;
    wall.push(Date.now() - started);

    await page.click('.tk-grid2 button:has-text("Close")').catch(() => undefined);
    await market.fill();
    for (let wait = 0; wait < 20; wait += 1) {
      if (/No active position/.test(await positionText())) break;
      await stepReplay(page, 6);
      await page.waitForTimeout(400);
    }
    if (/No active position/.test(await positionText())) closed += 1;

    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${ORDERS} round trips\n`);
  }

  const report = await read();
  const sorted = [...wall].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;

  console.log('\nsegment       count     p50     p95     p99   worst');
  for (const [stage, value] of Object.entries(report ?? {})) {
    if (typeof value !== 'object' || value === null) continue;
    console.log(
      `${stage.padEnd(12)} ${String(value.count).padStart(5)} ` +
        `${String(value.p50).padStart(7)} ${String(value.p95).padStart(7)} ` +
        `${String(value.p99).padStart(7)} ${String(value.worst).padStart(7)}`,
    );
  }
  console.log(
    `\norders answered ${report?.orders ?? 0}, rejected ${report?.rejected ?? 0}, ` +
      `unreconciled ${report?.unreconciled ?? 0}`,
  );
  console.log(`positions opened ${opened}/${ORDERS}, closed ${closed}/${ORDERS}`);
  console.log(`wall clock per round trip: p50 ${at(0.5)}ms, p95 ${at(0.95)}ms, worst ${sorted.at(-1)}ms`);
  console.log(`page errors: ${errors.length === 0 ? 'none' : errors.slice(0, 3).join(' | ')}`);

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify(
        { recordedAt: new Date().toISOString(), market: market.mode, orders: ORDERS, report, wall },
        null,
        2,
      ),
    );
    console.log(`\nwritten to ${JSON_OUT}`);
  }
} finally {
  await browser.close();
}
