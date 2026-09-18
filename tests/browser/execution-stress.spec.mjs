/**
 * The order ticket, used faster than it expects.
 *
 * Nobody clicks BUY once and waits politely. They click it twice because the
 * first one did not look like it did anything, they change the size while a
 * fill is in flight, they hit Close and then Buy again, they mash Reverse.
 * None of that may produce a position the server does not have.
 *
 * The rule this suite exists to defend: the SERVER is the authority. Every
 * check compares what the terminal is showing against what the engine says it
 * holds, and a disagreement is a failure however reasonable the terminal's
 * version looks.
 *
 * Run inside a PAUSED replay, so the market holds still and every difference
 * is the terminal's doing rather than the market's.
 */
import { createReport, launch, shot, signIn, useAccount, useSymbol } from './harness.mjs';

const { say, finish, watch } = createReport('execution-stress');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });
watch(page);

const positionText = async () =>
  ((await page.textContent('[data-testid=ticket-position]')) ?? '').replace(/\s+/g, ' ');

/** What the SERVER holds for this account, read straight from the API. */
const serverState = () =>
  page.evaluate(async () => {
    const refreshToken = window.localStorage.getItem('atlas.refreshToken');
    const session = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).then((r) => r.json());
    window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
    const auth = { authorization: `Bearer ${session.accessToken}` };
    /*
     * The account the TERMINAL is on, by id.
     *
     * Names repeat - this trader has two accounts called "Evaluation 150K" -
     * so asking the API for an account by name can read a different account
     * from the one on the screen, and then the two "disagreeing" is the test's
     * own doing.
     */
    const selected = document.querySelector('.abar-account')?.value ?? null;
    const accounts = await fetch('/api/v1/accounts', { headers: auth }).then((r) => r.json());
    const active =
      accounts.accounts?.find((a) => a.id === selected) ?? accounts.accounts?.[0];
    if (!active) return null;
    const [positions, orders] = await Promise.all([
      fetch(`/api/v1/positions?accountId=${active.id}`, { headers: auth }).then((r) => r.json()),
      fetch(`/api/v1/orders?accountId=${active.id}&open=true`, { headers: auth }).then((r) => r.json()),
    ]);
    const open = (positions.positions ?? []).filter((p) => p.qty !== 0);
    return {
      account: active.name,
      positions: open.map((p) => `${p.symbol} ${p.side} ${p.qty}`),
      qty: open.reduce((sum, p) => sum + Math.abs(p.qty), 0),
      working: (orders.orders ?? []).filter((o) => o.status === 'WORKING' || o.status === 'ACCEPTED')
        .length,
    };
  });

async function step(times = 1) {
  await page.click('[data-testid=apprail-practice]');
  await page.waitForTimeout(700);
  for (let i = 0; i < times; i += 1) {
    await page.click('.practice-row .chip:has-text("Step")');
    await page.waitForTimeout(700);
  }
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(600);
}

async function stepUntil(until, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    if (until(await positionText())) return true;
    await step();
  }
  return until(await positionText());
}

async function flatten() {
  const close = page.locator('.tk-grid2 button:has-text("Close")');
  if (await close.isEnabled().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(1_200);
    await stepUntil((text) => /No active position/.test(text));
  }
  const cancel = page.locator('.tk-grid2 button:has-text("Cancel orders")');
  if (await cancel.isEnabled().catch(() => false)) {
    await cancel.click();
    await page.waitForTimeout(1_500);
  }
  await page.waitForTimeout(800);
}

/** The terminal and the server, on the same question. */
async function agree(label) {
  const server = await serverState();
  const shown = await positionText();
  const flat = /No active position/.test(shown);
  const matches = flat ? server.qty === 0 : server.qty > 0;
  say(matches, label, `terminal "${shown.slice(0, 40)}" · server ${JSON.stringify(server)}`);
  return server;
}

try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');

  // --- a paused replay, so the market holds still --------------------------
  await page.click('[data-testid=apprail-practice]');
  await page.waitForSelector('[data-testid=drawer-practice]', { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  if (await page.locator('.practice-active').count()) {
    await page.click('.practice-active .chip');
    await page.waitForTimeout(6_000);
  }
  const sessions = await page.locator('.practice-session').count();
  say(sessions > 0, 'a recording is available to trade against', `${sessions}`);
  await page.locator('.practice-session').first().click();
  await page.waitForTimeout(9_000);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(1_500);

  /*
   * A replay has no price until it has emitted one.
   *
   * An order placed in that window is REFUSED - "no market data for this
   * instrument yet" - which is the engine being right and the test being
   * early, and the chart's own status line is no guide because it can still be
   * showing the live session's last price. The only honest test of "can this
   * engine fill" is to ask it to, so a single probe order is placed and the
   * market stepped until one is taken. It is flattened immediately after.
   */
  let warm = false;
  for (let i = 0; i < 10 && !warm; i += 1) {
    await page.click('[data-testid=buy]');
    await page.waitForTimeout(900);
    const state = await serverState();
    warm = state.qty > 0 || state.working > 0;
    if (!warm) await step(2);
  }
  say(warm, 'the replay reaches a price the engine can fill at');
  await flatten();
  /*
   * Refusals before that point are the engine doing its job, and they arrive
   * as 422s on the console. Everything counted from here is the suite's own.
   */
  const noiseFloor = errors.length;
  await agree('the account starts flat');

  // --- five BUY clicks in under a second -----------------------------------
  const quantity = async () => Number(await page.inputValue('#tk-qty')) || 1;
  const size = await quantity();
  for (let i = 0; i < 5; i += 1) {
    await page.click('[data-testid=buy]', { delay: 10 });
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(2_500);
  // A paused replay fills nothing until the market moves, so it is moved.
  await stepUntil((text) => /LONG/.test(text));
  await page.waitForTimeout(1_500);
  const rejected = await page.locator('[data-testid=toast], .toast, .tk-error').allTextContents();
  if (rejected.length > 0) console.log('  ticket said:', rejected.join(' | ').slice(0, 160));
  const afterFive = await agree('five BUY clicks leave the terminal agreeing with the engine');
  say(
    afterFive.qty === size * 5,
    'and every one of them is a contract the engine actually holds',
    `${afterFive.qty} contracts for ${size}x5 clicked`,
  );
  await shot(page, 'execution-stress-five-clicks');

  // --- close and buy again, immediately ------------------------------------
  const closeNow = page.locator('.tk-grid2 button:has-text("Close")');
  if (await closeNow.isEnabled().catch(() => false)) await closeNow.click();
  await page.waitForTimeout(250);
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(2_500);
  await step(2);
  const churned = await agree('a close and an entry in the same second do not confuse it');
  say(churned.positions.length <= 1, 'and there is at most one position in one instrument', JSON.stringify(churned.positions));

  // --- reverse, three times as fast as it can fill -------------------------
  for (let i = 0; i < 3; i += 1) {
    const reverse = page.locator('.tk-grid2 button:has-text("Reverse")');
    if (await reverse.isEnabled().catch(() => false)) await reverse.click();
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(2_500);
  await step(2);
  const reversed = await agree('reversing faster than it can fill still matches the engine');
  say(
    reversed.positions.length <= 1,
    'and does not leave two positions in the same instrument',
    JSON.stringify(reversed.positions),
  );

  // --- the size control, changed while an order is in flight ---------------
  await flatten();
  const plus = page.locator('button[aria-label="More contracts"]').first();
  for (let i = 0; i < 6; i += 1) {
    await plus.click();
    await page.waitForTimeout(40);
  }
  const wanted = await quantity();
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(2_000);
  await step(2);
  const sized = await serverState();
  say(
    sized.qty === wanted,
    'the size that was on the screen is the size that was sent',
    `screen ${wanted}, engine ${sized.qty}`,
  );

  // --- cancel while working ------------------------------------------------
  await flatten();
  const cancelled = await serverState();
  say(cancelled.qty === 0 && cancelled.working === 0, 'flattening leaves nothing behind', JSON.stringify(cancelled));

  // --- and a reload agrees with all of it ----------------------------------
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);
  await agree('and a reload shows the same account the engine has');

  say(
    errors.length === noiseFloor,
    'no page errors once the market is live',
    errors.slice(noiseFloor).join(' | ').slice(0, 200),
  );
} finally {
  await flatten().catch(() => {});
  await browser.close();
}

process.exit(finish());
