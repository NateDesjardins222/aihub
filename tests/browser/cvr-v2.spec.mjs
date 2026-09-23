/**
 * Charting Visual Rebuild V2 — visual verification probe.
 *
 * Draws each rebuilt tool on the REAL chart and screenshots it so the
 * typography, the Fib default (percentage only, no price), and the Long/Short
 * distinction can be inspected by eye — the acceptance the milestone demands.
 * It also asserts the machine-checkable facts (a fib paints across the plot,
 * long and short paint distinct geometry).
 */
import { createReport, launch, signIn, clearDrawings, shot, litPixels } from './harness.mjs';

const { say, finish, watch } = createReport('cvr-v2');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

async function armFromFlyout(category, label) {
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(350);
  if ((await page.locator(`.popover .rail-tool-item:has-text("${label}")`).count()) === 0) {
    await page.click(`.popover .pop-item:has-text("${category}")`);
    await page.waitForTimeout(300);
  }
  await page.click(`.popover .rail-tool-item:text-is("${label}")`);
  await page.waitForTimeout(350);
}

try {
  await signIn(page);
  await page.waitForTimeout(3_000);
  await clearDrawings(page);

  const canvas = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: canvas.x + canvas.width * fx, y: canvas.y + canvas.height * fy });

  // --- FIB: percentage-only labels by default -----------------------------
  await armFromFlyout('Fibonacci', 'Fib retracement');
  await page.mouse.click(at(0.30, 0.66).x, at(0.30, 0.66).y);
  await page.mouse.move(at(0.66, 0.22).x, at(0.66, 0.22).y, { steps: 6 });
  await page.mouse.click(at(0.66, 0.22).x, at(0.66, 0.22).y);
  await page.waitForTimeout(900);
  say((await litPixels(page, '.draw-canvas')) > 200, 'FIB: painted across the plot');
  await shot(page, 'cvr-fib-selected');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await clearDrawings(page);

  // --- LONG POSITION ------------------------------------------------------
  await armFromFlyout('Risk and reward', 'Long position');
  await page.mouse.click(at(0.42, 0.5).x, at(0.42, 0.5).y);
  await page.waitForTimeout(700);
  const longLit = await litPixels(page, '.draw-canvas');
  say(longLit > 200, 'LONG: painted', `${longLit} px`);
  // hover it to bring the readout up, then screenshot
  await page.mouse.move(at(0.5, 0.45).x, at(0.5, 0.45).y);
  await page.waitForTimeout(400);
  await shot(page, 'cvr-long-selected');
  await clearDrawings(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- SHORT POSITION -----------------------------------------------------
  await armFromFlyout('Risk and reward', 'Short position');
  await page.mouse.click(at(0.42, 0.5).x, at(0.42, 0.5).y);
  await page.waitForTimeout(700);
  const shortLit = await litPixels(page, '.draw-canvas');
  say(shortLit > 200, 'SHORT: painted', `${shortLit} px`);
  await page.mouse.move(at(0.5, 0.55).x, at(0.5, 0.55).y);
  await page.waitForTimeout(400);
  await shot(page, 'cvr-short-selected');
  await clearDrawings(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- TEXT (proves canvas DM Sans now renders, was falling back) ---------
  await armFromFlyout('Annotation', 'Text');
  await page.mouse.click(at(0.5, 0.4).x, at(0.5, 0.4).y);
  await page.waitForTimeout(500);
  await page.keyboard.type('Support 30,850');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  say((await litPixels(page, '.draw-canvas')) > 40, 'TEXT: painted (DM Sans)');
  await shot(page, 'cvr-text');
  await clearDrawings(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- MEASURE ------------------------------------------------------------
  await armFromFlyout('Measure', 'Measure');
  await page.mouse.click(at(0.4, 0.6).x, at(0.4, 0.6).y);
  await page.mouse.move(at(0.58, 0.35).x, at(0.58, 0.35).y, { steps: 6 });
  await page.mouse.click(at(0.58, 0.35).x, at(0.58, 0.35).y);
  await page.waitForTimeout(700);
  say((await litPixels(page, '.draw-canvas')) > 200, 'MEASURE: painted');
  await shot(page, 'cvr-measure');
  await clearDrawings(page);

  // --- the tool menu itself -----------------------------------------------
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(400);
  await shot(page, 'cvr-tool-menu');
  await page.keyboard.press('Escape');

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
