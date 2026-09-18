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
  /**
   * How many pixels of the crosshair's own colour each ROW of a slice of the
   * plot holds.
   *
   * A row profile rather than a total. Counting every crosshair-coloured pixel
   * made "three times as thick" read as about 1.4 times as much ink - the
   * dashes, the antialiased edges and the price label all dilute it - and a
   * threshold of 1.4 on a measurement of 1.40 is not a check. The THICKNESS is
   * what the setting controls, so the thickness is what is measured.
   */
  const rowProfile = async () =>
    page.evaluate(() => {
      // Layered canvases: the crosshair is not drawn on the same one as the
      // candles, so every canvas of the plot contributes to the profile.
      const canvases = [...document.querySelectorAll('.chart-canvas canvas')].filter(
        (c) => c.width > 400 && c.height > 200,
      );
      const rows = Math.min(...canvases.map((c) => c.height), 600);
      if (!Number.isFinite(rows) || rows <= 0) return { profile: [], slice: 0 };
      const slice = Math.floor(Math.min(...canvases.map((c) => c.width)) * 0.2);
      const profile = new Array(rows).fill(0);
      for (const canvas of canvases) {
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        // A slice well left of the pointer, so the VERTICAL line is not in it.
        const data = ctx.getImageData(Math.floor(canvas.width * 0.1), 0, slice, rows).data;
        for (let y = 0; y < rows; y += 1) {
          for (let x = 0; x < slice; x += 1) {
            const i = (y * slice + x) * 4;
            // The default crosshair blue, loosely: blue dominant, mid-bright.
            if (data[i + 2] > 120 && data[i + 2] - data[i] > 40 && data[i + 2] - data[i + 1] > 30) {
              profile[y] += 1;
            }
          }
        }
      }
      return { profile, slice };
    });

  /*
   * The thickness of the crosshair's horizontal line, in pixels.
   *
   * A moving average and the RSI are blue too, so the profile is read with the
   * pointer OFF the chart and again with it ON: a row that gains most of the
   * slice is a row the crosshair line occupies, and nothing else in the chart
   * spans a fifth of its width horizontally.
   */
  const crosshairThickness = async () => {
    await page.mouse.move(at(0.5, 0.02).x, box.y - 30);
    await page.waitForTimeout(450);
    const without = await rowProfile();
    await page.mouse.move(at(0.5, 0.5).x, at(0.5, 0.5).y);
    await page.waitForTimeout(450);
    const withIt = await rowProfile();
    if (withIt.profile.length === 0) return 0;
    // A third of the slice: the line is dashed, so it fills about half of any
    // row it crosses, and a third is comfortably below that and far above what
    // anything else in the chart puts on one row.
    const enough = Math.max(4, Math.floor(withIt.slice / 3));
    let gained = 0;
    for (let y = 0; y < withIt.profile.length; y += 1) {
      if (withIt.profile[y] - (without.profile[y] ?? 0) >= enough) gained += 1;
    }
    return gained;
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
  const thin = await crosshairThickness();
  say(thin >= 1, 'the crosshair paints when the pointer is over the plot', `${thin} px thick`);

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
  const thick = await crosshairThickness();
  say(
    thick >= thin + 2,
    'and thickening it actually paints a thicker crosshair',
    `${thin} px -> ${thick} px thick`,
  );

  // Put it back, since appearance persists for this trader.
  await setThickness(1);

  await shot(page, 'chart-navigation');
  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
