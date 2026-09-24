/**
 * V5 — the Parallel Channel places and paints in the real product.
 *
 * Deterministic model tests prove the geometry; this proves the whole pipeline
 * reaches it: the tool appears under "Channels & Pitchforks" in the catalogue,
 * three clicks create a PARALLEL_CHANNEL drawing, and it actually paints on the
 * canvas.
 *
 *   node tests/browser/parallel-channel.spec.mjs
 */
import { createReport, launch, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('parallel-channel');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

async function arm(category, label) {
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(350);
  const section = page.locator(`.popover .pop-item:has-text("${category}")`).first();
  const expanded = await section.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await section.click();
    await page.waitForTimeout(300);
  }
  await page.click(`.popover .rail-tool-item:has(.rail-tool-name:text-is("${label}"))`);
  await page.waitForTimeout(400);
}

/** Lit pixels on the drawing overlay — proof it actually painted. */
async function litPixels() {
  return page.evaluate(() => {
    const canvas = document.querySelector('.draw-canvas');
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n += 1;
    return n;
  });
}

try {
  await signIn(page);
  const before = await page.evaluate(() => window.__atlasStoredDrawings?.() ?? 0);

  await arm('Channels & Pitchforks', 'Parallel channel');
  say((await page.evaluate(() => window.__atlasTool?.())) === 'PARALLEL_CHANNEL', 'the parallel channel tool is armed');

  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  // Three clicks: base start, base end, then the width.
  await page.mouse.click(at(0.3, 0.55).x, at(0.3, 0.55).y);
  await page.waitForTimeout(150);
  await page.mouse.click(at(0.6, 0.45).x, at(0.6, 0.45).y);
  await page.waitForTimeout(150);
  await page.mouse.click(at(0.45, 0.62).x, at(0.45, 0.62).y);
  await page.waitForTimeout(400);

  const after = await page.evaluate(() => window.__atlasStoredDrawings?.() ?? 0);
  say(after === before + 1, 'three clicks create exactly one drawing', `${before} → ${after}`);

  const kinds = await page.evaluate(() => (window.__atlasDrawings?.() ?? []).map((d) => d.kind));
  say(kinds.includes('PARALLEL_CHANNEL'), 'the created drawing is a PARALLEL_CHANNEL', kinds.join(','));

  const lit = await litPixels();
  say(lit > 200, 'the channel actually paints on the overlay', `${lit} px`);

  await page.screenshot({ path: '/tmp/atlas-shots/parallel-channel.png' }).catch(() => {});
  say(errors.length === 0, 'no console errors while placing the channel', errors.slice(0, 2).join(' | '));
} catch (error) {
  say(false, 'the suite ran without throwing', String(error).slice(0, 300));
} finally {
  await browser.close();
  process.exit(finish());
}
