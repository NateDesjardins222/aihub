/**
 * Chart styles and desktop proportions.
 *
 * The proportion check is the design rule made testable: the chart is the
 * application, so it has to keep most of the width at every common desktop
 * size, with nothing overflowing.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish } = createReport('layout');

const STYLES = [
  'Hollow candles',
  'Bars',
  'Line',
  'Line with markers',
  'Area',
  'Baseline',
  'Heikin Ashi',
  'Candles',
];

const RESOLUTIONS = [
  [1366, 768],
  [1440, 900],
  [1680, 1050],
  [1920, 1080],
  [2560, 1440],
];

const { browser, page, errors } = await launch();

try {
  await signIn(page);

  let allDrew = true;
  const thin = [];
  for (const style of STYLES) {
    await page.click('.chdr-icon >> nth=0');
    await page.waitForTimeout(400);
    await page.click(`.popover .pop-item:text-is("${style}")`);
    await page.waitForTimeout(1_200);
    const lit = await page.evaluate(() => {
      let total = 0;
      for (const canvas of document.querySelectorAll('.chart-canvas canvas')) {
        try {
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          const data = ctx.getImageData(0, 0, Math.min(canvas.width, 400), Math.min(canvas.height, 400)).data;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 30) total += 1;
        } catch {
          /* an offscreen or tainted canvas contributes nothing */
        }
      }
      return total;
    });
    if (lit < 500) {
      allDrew = false;
      thin.push(`${style}:${lit}`);
    }
  }
  say(allDrew, 'every offered chart style renders from the real bars', thin.join(' ') || `${STYLES.length} styles`);

  await page.click('.chdr-icon >> nth=0');
  await page.waitForTimeout(400);
  const unavailable = await page.locator('.popover .pop-item:disabled').allTextContents();
  say(
    unavailable.length === 4 && unavailable.every((text) => /unavailable/.test(text)),
    'styles needing tick data are listed as unavailable, not approximated',
    unavailable.map((t) => t.replace('unavailable', '').trim()).join(', '),
  );
  await page.keyboard.press('Escape');
  say(errors.length === 0, 'no page errors while switching styles', errors.join(' | '));
  await page.close();

  for (const [width, height] of RESOLUTIONS) {
    const sized = await browser.newPage({ viewport: { width, height } });
    const pageErrors = [];
    sized.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 140)));
    await signIn(sized);
    const chart = await sized.locator('.chart-canvas').boundingBox();
    const share = ((chart?.width ?? 0) / width) * 100;
    const overflow = await sized.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    const ticket = await sized.locator('.tk').boundingBox();
    say(
      !overflow && share > 68 && (ticket?.width ?? 0) > 150 && pageErrors.length === 0,
      `${width}x${height}: no overflow, the chart keeps ${share.toFixed(0)}% of the width`,
      pageErrors.join(' | '),
    );
    await shot(sized, `layout-${width}`);
    await sized.close();
  }
} finally {
  await browser.close();
}

process.exit(finish());
