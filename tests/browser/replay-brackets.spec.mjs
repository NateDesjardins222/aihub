/**
 * Stops and targets, end to end, in a replay.
 *
 * This is the check that the reported bug does not come back. It follows the
 * whole chain through the real interface: entry fill, bracket creation, working
 * children, a genuine market event reaching the level, the fill, the OCO
 * sibling canceled, the position flat, and a trade recorded.
 *
 * Nothing in it closes the position. If a leg does not execute, the position
 * stays open and the suite fails.
 */
import { createReport, launch, shot, signIn, useAccount, useSymbol, waitFor } from './harness.mjs';

const { say, finish, watch } = createReport('replay-brackets');
const { browser, page, errors } = await launch();
watch(page);

const positionText = async () =>
  ((await page.textContent('[data-testid=ticket-position]')) ?? '').replace(/\s+/g, ' ');

/** Set the bracket behaviour and distances in Settings. */
async function setBracket(mode, stopTicks, targetTicks) {
  await page.click('.abar-icon[aria-label=Settings]');
  await page.waitForTimeout(700);
  await page.click('.st-nav-item:text-is("Execution defaults")');
  await page.waitForTimeout(400);
  await page.click(
    `.st-row:has-text("On a fill") .st-choice-btn:text-is("${
      mode === 'AUTO' ? 'Attach a stop and target' : 'Nothing'
    }")`,
  );
  if (mode === 'AUTO') {
    await page.fill('.st-row:has-text("Stop distance") input', String(stopTicks));
    await page.fill('.st-row:has-text("Target distance") input', String(targetTicks));
  }
  await page.waitForTimeout(500);
  await page.click('.st-close');
  await page.waitForTimeout(900);
}

try {
  await signIn(page);
  // This suite trades NQ, so the ticket has to be pointed at NQ.
  await useSymbol(page, 'NQ');
  await useAccount(page, 'Practice 150K');

  // --- start a historical session -----------------------------------------
  await page.click('[data-testid=apprail-practice]');
  await page.waitForSelector('[data-testid=drawer-practice]', { timeout: 15_000 });
  await page.waitForTimeout(2_500);

  if (await page.locator('.practice-active').count()) {
    await page.click('.practice-active .chip');
    await page.waitForTimeout(6_000);
  }
  const sessions = await page.locator('.practice-session').count();
  say(sessions > 0, 'the practice drawer lists captured sessions', `${sessions}`);
  if (sessions === 0) throw new Error('no recording to replay');

  await page.locator('.practice-session').first().click();
  await page.waitForTimeout(9_000);
  say((await page.locator('.practice-active').count()) > 0, 'a replay session starts');
  say((await page.locator('.abar-pill-warn').count()) > 0, 'the account bar marks the terminal as replaying');

  await page.click('.practice-row .chip:has-text("Restart")');
  await page.waitForTimeout(2_500);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(800);

  // --- an Auto bracket, attached to the entry ------------------------------
  // Bracket behaviour is an execution DEFAULT now, not a control on the ticket:
  // a trader placing an order chooses a side and a size.
  await setBracket('AUTO', 20, 40);

  await page.click('[data-testid=apprail-practice]');
  await page.waitForTimeout(1_200);
  await page.click('.practice-row .chip:has-text("+30")');
  await page.waitForTimeout(3_000);
  await page.click('[data-testid=drawer-practice] .drawer-close');
  await page.waitForTimeout(600);

  await page.click('.tk-preset:text-is("1")');
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(1_800);
  say(
    /No active position/.test(await positionText()),
    'an order placed while the replay is paused simply waits',
  );

  // --- run it --------------------------------------------------------------
  await page.click('[data-testid=apprail-practice]');
  await page.waitForTimeout(1_200);
  await page.click('.practice-speeds .chip:text-is("50×")');
  await page.waitForTimeout(600);
  await page.click('.practice-row .chip:has-text("Play")');
  await page.waitForTimeout(600);
  await page.click('[data-testid=drawer-practice] .drawer-close');

  const opened = await waitFor(page, positionText, (text) => /LONG 1/.test(text), { tries: 20, every: 1_000 });
  say(opened.ok, 'the entry fills once the replay moves', opened.value.slice(0, 45));

  const stop = await page.locator('[data-marker=stop]').count();
  const target = await page.locator('[data-marker=target]').count();
  say(stop === 1 && target === 1, 'Auto attaches both legs on the fill', `stop ${stop}, target ${target}`);
  await shot(page, 'replay-bracket');

  const closed = await waitFor(page, positionText, (text) => /No active position/.test(text));
  say(closed.ok, 'a protective leg closes the position by itself', `after ~${closed.waitedMs / 1000}s`);

  await page.click('.tab:text-is("Orders")');
  await page.waitForTimeout(1_800);
  const orders = ((await page.textContent('.panel-body')) ?? '').replace(/\s+/g, ' ');
  say(/FILLED/.test(orders) && /(STOP LOSS|TAKE PROFIT)/.test(orders), 'the fill is a bracket leg', orders.slice(0, 170));
  say(/CANCELED/.test(orders), 'the OCO sibling was canceled');

  await page.click('.tab:text-is("Trades")');
  await page.waitForTimeout(1_800);
  const trades = ((await page.textContent('.panel-body')) ?? '').replace(/\s+/g, ' ');
  say(/NQ/.test(trades) && !/No closed trades/.test(trades), 'a closed round-trip was recorded', trades.slice(0, 150));
  await shot(page, 'replay-filled');

  // --- back to live --------------------------------------------------------
  await page.click('[data-testid=apprail-practice]');
  await page.waitForTimeout(1_500);
  if (await page.locator('.practice-active .chip').count()) {
    await page.click('.practice-active .chip');
    await page.waitForTimeout(6_000);
  }
  await page.click('[data-testid=drawer-practice] .drawer-close').catch(() => undefined);
  await page.waitForTimeout(1_500);
  say(
    (await page.locator('.abar-pill-warn:text-is("REPLAY")').count()) === 0,
    'ending the session returns the terminal to the live feed',
  );

  // Back to the default, so the next suite starts from a clean workspace.
  await setBracket('OFF');

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
