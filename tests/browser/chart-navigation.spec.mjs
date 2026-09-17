/**
 * Pan, zoom, the wheel, and the axes.
 *
 * The complaint was about FEEL: "Atlas currently zooms too directly inward".
 * Feel is not directly testable, but the things that produce it are: whether
 * the bar under the cursor stays under the cursor, whether the newest bar
 * keeps its margin, how much one notch of the wheel changes, and whether the
 * axes do what dragging an axis should do. Each is measured here from the
 * chart's own geometry.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish } = createReport('chart-navigation');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });

/** The chart's visible logical range and bar spacing, read from the page. */
const view = () =>
  page.evaluate(() => {
    const el = document.querySelector('.chart-canvas');
    return el ? (window.__atlasChartView?.() ?? null) : null;
  });

/** The price under a given x, as the chart itself reports it. */
async function barTimeAt(fx) {
  const box = await page.locator('.chart-canvas').boundingBox();
  const x = box.x + box.width * fx;
  await page.mouse.move(x, box.y + box.height * 0.5);
  await page.waitForTimeout(220);
  const legend = await page.locator('[data-testid=status-line]').innerText();
  return legend.replace(/\s+/g, ' ');
}

try {
  await signIn(page);
  await page.waitForTimeout(4000);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  // --- one notch of the wheel ----------------------------------------------
  const spacingBefore = await view();
  say(spacingBefore !== null, 'the chart exposes its geometry for measurement', JSON.stringify(spacingBefore));

  await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);
  const zoomedIn = await view();
  say(
    zoomedIn.span < spacingBefore.span,
    'one notch forward zooms in',
    `${spacingBefore.span.toFixed(1)} bars -> ${zoomedIn.span.toFixed(1)} bars`,
  );
  const step = spacingBefore.span / zoomedIn.span;
  say(
    step > 1.03 && step < 1.25,
    'and it is a nudge rather than a jump',
    `${((step - 1) * 100).toFixed(1)}% per notch`,
  );

  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(300);
  const back = await view();
  say(
    Math.abs(back.span - spacingBefore.span) / spacingBefore.span < 0.02,
    'a notch back returns to where it was',
    `${spacingBefore.span.toFixed(1)} -> ${back.span.toFixed(1)}`,
  );

  // --- the bar under the cursor stays under the cursor ----------------------
  for (const fx of [0.25, 0.75]) {
    await page.mouse.move(at(fx, 0.5).x, at(fx, 0.5).y);
    await page.waitForTimeout(200);
    const anchorBefore = await page.evaluate((x) => window.__atlasChartView?.(x)?.logicalAtX ?? null,
      box.width * fx);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(350);
    const anchorAfter = await page.evaluate((x) => window.__atlasChartView?.(x)?.logicalAtX ?? null,
      box.width * fx);
    say(
      anchorBefore !== null && anchorAfter !== null && Math.abs(anchorAfter - anchorBefore) < 0.75,
      `zooming holds the bar under the cursor at ${Math.round(fx * 100)}% across`,
      `logical ${anchorBefore?.toFixed(2)} -> ${anchorAfter?.toFixed(2)}`,
    );
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
  }

  // --- the right offset ----------------------------------------------------
  await page.click('.chart-nav button[title="Scroll to the newest bar"]');
  await page.waitForTimeout(700);
  const edgeBefore = await view();
  await page.mouse.move(at(0.95, 0.5).x, at(0.95, 0.5).y);
  await page.mouse.wheel(0, 240); // zoom OUT at the right edge
  await page.waitForTimeout(400);
  const edgeAfter = await view();
  say(
    edgeAfter.span > edgeBefore.span,
    'zooming out at the right edge widens the view',
    `${edgeBefore.span.toFixed(0)} -> ${edgeAfter.span.toFixed(0)} bars`,
  );
  say(
    Math.abs(edgeAfter.to - edgeBefore.to) < 3,
    'and the newest bar keeps its place, instead of being pulled to the middle',
    `right edge logical ${edgeBefore.to.toFixed(1)} -> ${edgeAfter.to.toFixed(1)}`,
  );

  // --- shift-wheel pans ----------------------------------------------------
  const panBefore = await view();
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 240);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(350);
  const panAfter = await view();
  say(
    Math.abs(panAfter.span - panBefore.span) < 1.5 && Math.abs(panAfter.from - panBefore.from) > 1,
    'shift and the wheel scrolls through time without zooming',
    `from ${panBefore.from.toFixed(1)} -> ${panAfter.from.toFixed(1)}, span ${panBefore.span.toFixed(1)} -> ${panAfter.span.toFixed(1)}`,
  );

  // --- dragging the price axis --------------------------------------------
  const scaleBefore = await page.evaluate(() => window.__atlasChartView?.()?.priceRange ?? null);
  const axis = { x: box.x + box.width - 30, y: box.y + box.height * 0.5 };
  await page.mouse.move(axis.x, axis.y);
  await page.mouse.down();
  await page.mouse.move(axis.x, axis.y + 120, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const scaleAfter = await page.evaluate(() => window.__atlasChartView?.()?.priceRange ?? null);
  say(
    scaleBefore !== null && scaleAfter !== null && Math.abs(scaleAfter - scaleBefore) > 0.5,
    'dragging the price axis changes the vertical scale',
    `${scaleBefore?.toFixed(1)} -> ${scaleAfter?.toFixed(1)} points visible`,
  );

  // --- dragging the time axis ---------------------------------------------
  const timeBefore = await view();
  const timeAxis = { x: box.x + box.width * 0.5, y: box.y + box.height - 12 };
  await page.mouse.move(timeAxis.x, timeAxis.y);
  await page.mouse.down();
  await page.mouse.move(timeAxis.x - 150, timeAxis.y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const timeAfter = await view();
  say(
    Math.abs(timeAfter.span - timeBefore.span) > 1,
    'dragging the time axis changes the bar spacing',
    `${timeBefore.span.toFixed(1)} -> ${timeAfter.span.toFixed(1)} bars in view`,
  );

  // --- panning and drawing coexist ----------------------------------------
  await page.click('.rail .rail-btn[aria-label="Horizontal line"]');
  await page.mouse.click(at(0.45, 0.45).x, at(0.45, 0.45).y);
  await page.waitForTimeout(500);
  const withDrawing = await view();
  await page.mouse.move(at(0.8, 0.08).x, at(0.8, 0.08).y);
  await page.mouse.down();
  await page.mouse.move(at(0.55, 0.08).x, at(0.8, 0.08).y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterPan = await view();
  say(
    Math.abs(afterPan.from - withDrawing.from) > 2,
    'the chart still pans with an object on it',
    `from ${withDrawing.from.toFixed(1)} -> ${afterPan.from.toFixed(1)}`,
  );

  // --- the crosshair is customisable, and the setting reaches the canvas ---
  /** How many pixels of the crosshair's own colour a column of the plot has. */
  const crosshairInk = async () =>
    page.evaluate(() => {
      // The renderer's own canvas, not the drawing overlay.
      const canvases = [...document.querySelectorAll('.chart-canvas canvas')];
      let count = 0;
      for (const canvas of canvases) {
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        const { width, height } = canvas;
        if (width === 0 || height === 0) continue;
        const data = ctx.getImageData(0, 0, width, Math.min(height, 400)).data;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          // The default crosshair blue, loosely: blue dominant, mid-bright.
          if (b > 120 && b - r > 40 && b - g > 30) count += 1;
        }
      }
      return count;
    });

  /*
   * The crosshair's own contribution, isolated.
   *
   * A moving average and the RSI are blue too, so a raw count of blue pixels
   * is mostly indicators. Reading the canvas with the pointer OFF the chart
   * and again with it ON gives the difference the crosshair itself makes.
   */
  const crosshairContribution = async () => {
    await page.mouse.move(at(0.5, 0.02).x, box.y - 30);
    await page.waitForTimeout(450);
    const without = await crosshairInk();
    await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
    await page.waitForTimeout(450);
    const withIt = await crosshairInk();
    return withIt - without;
  };

  /** Set the crosshair thickness through the settings dialog. */
  const setThickness = async (value) => {
    await page.click('.abar-icon[aria-label=Settings]');
    await page.waitForTimeout(800);
    await page.click('.st-nav-item:has-text("Scales and lines")');
    await page.waitForTimeout(400);
    const input = page
      .locator('.st-row:has(.st-row-label:text-is("Thickness")) input[type=number]')
      .first();
    await input.fill(String(value));
    await input.dispatchEvent('change');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    return (await page.locator('.st-scrim').count()) === 0;
  };

  // Appearance persists, so the starting point is set explicitly rather than
  // assumed - a test that "changes" a setting to the value it already has
  // proves nothing.
  const closedByEscape = await setThickness(1);
  say(closedByEscape, 'Escape closes the settings dialog');
  const thin = await crosshairContribution();
  say(thin > 200, 'the crosshair paints when the pointer is over the plot', `${thin} px`);

  await page.click('.abar-icon[aria-label=Settings]');
  await page.waitForTimeout(900);
  await page.click('.st-nav-item:has-text("Scales and lines")');
  await page.waitForTimeout(500);
  const rows = await page.locator('.st-row-label').allTextContents();
  for (const wanted of ['Style', 'Colour', 'Line style', 'Thickness', 'Strength', 'Price label', 'Time label']) {
    say(rows.includes(wanted), `the crosshair can be given a ${wanted.toLowerCase()}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await setThickness(3);
  const thick = await crosshairContribution();
  say(
    thick > thin * 1.4,
    'and thickening it actually paints a thicker crosshair',
    `${thin} px -> ${thick} px of crosshair ink`,
  );

  // Put it back, since appearance persists for this trader.
  await setThickness(1);

  await shot(page, 'chart-navigation');
  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
