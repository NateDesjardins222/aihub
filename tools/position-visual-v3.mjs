/**
 * Q3 §7/§8 visual check: the Long/Short position tool with the LONG/SHORT pill
 * REMOVED and the labels reduced to R:R + points.
 *
 *   node tools/position-visual-v3.mjs
 *
 * Photographs each tool at rest (should show a small R:R on the entry, no pill,
 * direction read from the zones) and selected (points + R:R, no ticks/$ by
 * default).
 */
import { launch, shot, signIn, useSymbol, clearDrawings } from '../tests/browser/harness.mjs';

const at = (box, fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

async function arm(page, category, label) {
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(400);
  const tool = page.locator('.popover .rail-tool-item').filter({ hasText: label }).first();
  if (!(await tool.isVisible().catch(() => false))) {
    // Category rows render as "<name><count>" (e.g. "Projection2"); expand it.
    await page.locator('.popover .pop-item').filter({ hasText: category }).first().click();
    await page.waitForTimeout(400);
  }
  await tool.click();
  await page.waitForTimeout(400);
}

const objects = (page) => page.evaluate(() => window.__atlasDrawings?.() ?? null);

const { browser, page, errors } = await launch({ width: 1680, height: 1050 });

try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await page.waitForTimeout(3500);

  for (const { label, tag } of [
    { label: 'Long position', tag: 'long' },
    { label: 'Short position', tag: 'short' },
  ]) {
    await clearDrawings(page);
    await page.waitForTimeout(400);
    const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();

    await arm(page, 'Projection', label);
    const armed = await page.evaluate(() => window.__atlasTool?.() ?? null);
    console.log(`${label}: armed=${armed}`);

    const p = at(box, 0.4, 0.5);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(600);

    const all = await objects(page);
    console.log(`${label}: placed ${all?.length ?? '?'} object(s)`);
    // At rest (deselect first so no handles/inspect readout).
    await page.evaluate(() => window.__atlasSelect?.(''));
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.2);
    await page.waitForTimeout(300);
    await shot(page, `v3-position-${tag}-rest`);

    // Selected (inspect readout: points + R:R).
    const id = all?.[0]?.id ?? null;
    if (id) await page.evaluate((x) => window.__atlasSelect?.(x), id);
    await page.waitForTimeout(400);
    await shot(page, `v3-position-${tag}-selected`);
  }

  console.log(`page errors: ${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
} finally {
  await browser.close();
}
