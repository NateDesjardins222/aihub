/**
 * Indicators as editable objects.
 *
 * The brief's workflow, verbatim: "add EMA 9, change it to EMA 21, add EMA 50
 * simultaneously, change colours" - and "I currently cannot confidently tell
 * what EMA length I have. This is unacceptable."
 *
 * So every check here is about whether the length is VISIBLE and whether the
 * instances are genuinely independent, read from the legend rows a trader
 * looks at rather than from application state.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('indicators');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

const rowTexts = async () =>
  (await page.locator('[data-testid=indicator-row]').allTextContents()).map((t) =>
    t.replace(/\s+/g, ' ').trim(),
  );

/** Add an indicator from the header's picker. */
async function add(name) {
  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(700);
  // Scoped to the CATALOGUE: the menu also lists what is already on the
  // chart, and "Exponential moving average" matches both.
  await page.click(`[data-testid=indicator-catalogue] .pop-item:has-text("${name}")`);
  await page.waitForTimeout(800);
}

/** Set a numeric input in the open settings panel. */
async function setNumber(label, value) {
  const input = page
    .locator(`[data-testid=indicator-settings] .st-row:has(.st-row-label:text-is("${label}")) input[type=number]`)
    .first();
  await input.fill(String(value));
  await input.dispatchEvent('change');
  await page.waitForTimeout(500);
}

async function clearAll() {
  for (let i = 0; i < 12; i += 1) {
    const remove = page.locator('[data-testid=indicator-row] .ind-btn-danger').first();
    if ((await remove.count()) === 0) break;
    await remove.click();
    await page.waitForTimeout(350);
  }
}

/**
 * How many pixels of a given colour the price pane is painting.
 *
 * Read off the renderer's own canvases rather than from a screenshot, so the
 * count is of what was drawn rather than of what a JPEG made of it.
 */
const hueCount = (r0, g0, b0) =>
  page.evaluate(
    ([r, g, b]) => {
      let hits = 0;
      for (const canvas of document.querySelectorAll('[data-pane=p1] canvas')) {
        const ctx = canvas.getContext('2d');
        if (!ctx || canvas.width === 0) continue;
        let data;
        try {
          data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch {
          continue;
        }
        for (let i = 0; i < data.length; i += 4) {
          if (
            Math.abs(data[i] - r) < 30 &&
            Math.abs(data[i + 1] - g) < 30 &&
            Math.abs(data[i + 2] - b) < 30
          ) {
            hits += 1;
          }
        }
      }
      return hits;
    },
    [r0, g0, b0],
  );

/** Reopen the Bollinger instance's settings, whatever closed them. */
async function openBollinger() {
  if ((await page.locator('[data-testid=indicator-settings]').count()) === 1) return;
  await page.locator('[data-testid=indicator-row][data-kind=BOLL]').first().dblclick();
  await page.waitForSelector('[data-testid=indicator-settings]', { timeout: 10_000 });
  await page.waitForTimeout(700);
}

try {
  await signIn(page);
  await page.waitForTimeout(4500);
  await clearAll();
  say((await rowTexts()).length === 0, 'the chart starts with no indicators on it');

  // --- add EMA, and see its length ----------------------------------------
  await add('Exponential moving average');
  const opened = (await page.locator('[data-testid=indicator-settings]').count()) === 1;
  say(opened, 'adding an indicator opens its settings, with its inputs');

  const labels = await page
    .locator('[data-testid=indicator-settings] .st-row-label')
    .allTextContents();
  for (const wanted of [
    'Length',
    'Source',
    'Smoothing',
    'Colour',
    'Thickness',
    'Line style',
    'Opacity',
  ]) {
    say(labels.includes(wanted), `EMA exposes a real ${wanted.toLowerCase()} input`);
  }
  const visibility = await page
    .locator('[data-testid=indicator-settings] .st-row-label')
    .allTextContents();
  say(
    visibility.some((label) => /shown on the chart/i.test(label)),
    'and a visibility control in the same place as every other setting',
  );

  await setNumber('Length', 9);
  let rows = await rowTexts();
  say(
    rows.some((row) => /EMA 9/.test(row)),
    'the legend says exactly what length it is',
    rows.join(' / '),
  );

  // --- change it to 21 -----------------------------------------------------
  await setNumber('Length', 21);
  rows = await rowTexts();
  say(
    rows.some((row) => /EMA 21/.test(row)) && !rows.some((row) => /EMA 9/.test(row)),
    'changing the length changes the indicator, not a copy of it',
    rows.join(' / '),
  );

  // --- smoothing, on and off ----------------------------------------------
  /*
   * Smoothing is a second average applied to the LINE, and 1 means off. The
   * legend has to say so when it is on and say nothing when it is not: a
   * default that prints itself in the legend teaches a trader to ignore the
   * legend.
   */
  await setNumber('Smoothing', 5);
  rows = await rowTexts();
  say(
    rows.some((row) => /smoothed 5/.test(row)),
    'turning smoothing on says so in the legend',
    rows.join(' / '),
  );
  await setNumber('Smoothing', 1);
  rows = await rowTexts();
  say(
    !rows.some((row) => /smoothed/.test(row)) && rows.some((row) => /EMA 21/.test(row)),
    'and turning it off takes the word back out again',
    rows.join(' / '),
  );

  // --- a second and third EMA, independent --------------------------------
  await page.click('[data-testid=indicator-settings] button[aria-label="Close indicator settings"]');
  await page.waitForTimeout(400);
  await add('Exponential moving average');
  await setNumber('Length', 50);
  await page.click('[data-testid=indicator-settings] button[aria-label="Close indicator settings"]');
  await page.waitForTimeout(400);
  await add('Exponential moving average');
  await setNumber('Length', 200);

  // A different colour for the third one, so the chart can be read. Typed as a
  // hex rather than picked, which is the path the field is there for.
  const colour = page
    .locator('[data-testid=indicator-settings] .st-row:has(.st-row-label:text-is("Colour")) .cp-text')
    .first();
  await colour.fill('#ff5a5a');
  await colour.press('Enter');
  await page.waitForTimeout(500);
  await page.click('[data-testid=indicator-settings] button[aria-label="Close indicator settings"]');
  await page.waitForTimeout(500);

  rows = await rowTexts();
  say(
    rows.filter((row) => /EMA/.test(row)).length === 3,
    'three EMAs live on the chart at once',
    rows.join(' / '),
  );
  say(
    rows.some((r) => /EMA 21/.test(r)) &&
      rows.some((r) => /EMA 50/.test(r)) &&
      rows.some((r) => /EMA 200/.test(r)),
    'each with its own length, all visible without opening anything',
    rows.join(' / '),
  );

  const dots = await page
    .locator('[data-testid=indicator-row] .ind-dot')
    .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).backgroundColor));
  say(new Set(dots).size >= 2, 'and their own colours', dots.join(' / '));

  // --- values follow the crosshair -----------------------------------------
  const box = await page.locator('.chart-canvas').boundingBox();
  const valueAt = async (fx) => {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.5);
    await page.waitForTimeout(400);
    return page
      .locator('[data-testid=indicator-row] .ind-value')
      .first()
      .innerText()
      .catch(() => '');
  };
  const left = await valueAt(0.3);
  const right = await valueAt(0.75);
  say(
    left !== '' && right !== '' && left !== right,
    'the values read the bar under the crosshair',
    `${left} at 30% across, ${right} at 75%`,
  );

  // --- visibility and removal ---------------------------------------------
  await page.click('[data-testid=indicator-row] .ind-btn[aria-label^="Hide"]');
  await page.waitForTimeout(500);
  say(
    (await page.locator('[data-testid=indicator-row].ind-row-off').count()) === 1,
    'an indicator can be hidden without being removed',
  );
  await page.click('[data-testid=indicator-row] .ind-btn[aria-label^="Show"]');
  await page.waitForTimeout(400);

  const before = (await rowTexts()).length;
  await page.click('[data-testid=indicator-row] .ind-btn[aria-label^="Duplicate"]');
  await page.waitForTimeout(500);
  say((await rowTexts()).length === before + 1, 'and duplicated from its own row');

  await page.click('[data-testid=indicator-row] .ind-btn-danger');
  await page.waitForTimeout(500);
  say((await rowTexts()).length === before, 'and removed from its own row');

  // --- Bollinger bands: several plots, one row ----------------------------
  await add('Bollinger bands');
  const bbLabels = await page
    .locator('[data-testid=indicator-settings] .st-row-label')
    .allTextContents();
  say(
    bbLabels.includes('Length') && bbLabels.some((l) => /multiplier|deviation/i.test(l)),
    'Bollinger bands expose their own parameters',
    bbLabels.join(' / '),
  );

  /*
   * Three lines and a fill, each controlled on its own.
   *
   * One colour and one width for all three used to be the whole indicator's
   * appearance, so the basis could not be de-emphasised behind the bands. The
   * check is on PIXELS rather than on stored parameters: a setting that saves
   * and does not draw is not a setting.
   */
  const bbSections = await page
    .locator('[data-testid=indicator-settings] .st-group-title')
    .allTextContents();
  for (const wanted of ['Basis', 'Upper band', 'Lower band', 'Fill']) {
    say(bbSections.includes(wanted), `${wanted} has its own settings section`, bbSections.join(' / '));
  }

  const bbRows = (label) =>
    page
      .locator('[data-testid=indicator-settings] .st-row')
      .filter({ has: page.locator(`.st-row-label:text-is("${label}")`) });

  // Magenta at full strength, because it cannot be confused with anything
  // else the chart draws.
  const fillColour = bbRows('Colour').last().locator('.cp-text');
  await fillColour.fill('#ff00ff');
  await fillColour.press('Enter');
  const fillOpacity = bbRows('Opacity').last().locator('input[type=number]');
  await fillOpacity.fill('100');
  await fillOpacity.press('Enter');
  await page.waitForTimeout(1_200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const filled = await hueCount(255, 0, 255);
  say(filled > 2_000, 'the band between the bands is actually shaded', `${filled} px`);
  await shot(page, 'indicators-bollinger-fill');

  await openBollinger();
  await bbRows('Shown').last().locator('input[type=checkbox]').uncheck();
  await page.waitForTimeout(1_000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const unfilled = await hueCount(255, 0, 255);
  say(unfilled === 0, 'and turning the fill off removes every pixel of it', `${unfilled} px`);

  await openBollinger();
  const upperColour = bbRows('Colour').nth(1).locator('.cp-text');
  await upperColour.fill('#00ff00');
  await upperColour.press('Enter');
  const upperWidth = bbRows('Thickness').nth(1).locator('input[type=number]');
  await upperWidth.fill('4');
  await upperWidth.press('Enter');
  await page.waitForTimeout(1_200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const upperOnly = await hueCount(0, 255, 0);
  say(upperOnly > 500, 'the upper band takes its own colour and thickness', `${upperOnly} px`);

  await openBollinger();
  await bbRows('Shown').nth(0).locator('input[type=checkbox]').uncheck();
  await page.waitForTimeout(1_000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  const afterBasisHidden = await hueCount(0, 255, 0);
  say(
    Math.abs(afterBasisHidden - upperOnly) < upperOnly * 0.1,
    'and hiding the basis leaves the bands exactly where they were',
    `${upperOnly} -> ${afterBasisHidden} px`,
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  rows = await rowTexts();
  say(
    rows.some((row) => /BB 20 2/.test(row)),
    'and appear as one row, not three',
    rows.join(' / '),
  );

  // --- an oscillator gets its own pane, and its row goes with it ----------
  await add('Relative strength index');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const emaBox = await page
    .locator('[data-testid=indicator-row][data-kind=EMA]')
    .first()
    .boundingBox();
  const rsiBox = await page
    .locator('[data-testid=indicator-row][data-kind=RSI]')
    .first()
    .boundingBox();
  say(
    rsiBox !== null && emaBox !== null && rsiBox.y > emaBox.y + 150,
    "an oscillator's row sits in its own pane, not over the candles",
    `EMA row at y=${emaBox?.y}, RSI row at y=${rsiBox?.y}`,
  );

  await shot(page, 'indicators-three-emas');

  // --- persistence ---------------------------------------------------------
  const beforeReload = await rowTexts();
  await page.waitForTimeout(2_500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);
  const afterReload = await rowTexts();
  say(
    afterReload.length === beforeReload.length,
    'every indicator survives a reload',
    `${beforeReload.length} -> ${afterReload.length}`,
  );

  // --- removing one must not remove the next ------------------------------
  /*
   * Four of the same study, which is the case where it bites.
   *
   * Each row's controls sit at the right end of that row, so five DIFFERENT
   * studies have their remove buttons at five different x positions and a
   * second click in the same place misses. Four moving averages have rows of
   * identical width, the buttons line up exactly, and the list restacking
   * under a pointer that has not moved puts the next one's remove button
   * precisely where the last one was.
   */
  await clearAll();
  await page.waitForTimeout(600);
  for (let i = 0; i < 4; i += 1) await add('Exponential moving');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const stacked = await page.locator('[data-testid=indicator-row]').count();
  say(stacked === 4, 'four of the same study stack in the legend', `${stacked} rows`);

  const second = page.locator('[data-testid=indicator-row]').nth(1);
  await second.hover();
  await page.waitForTimeout(300);
  const target = await second.locator('.ind-btn-danger').boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterOne = await page.locator('[data-testid=indicator-row]').count();
  // The pointer does not move. This is the accidental second click.
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  const afterTwo = await page.locator('[data-testid=indicator-row]').count();
  say(
    afterOne === 3 && afterTwo === 3,
    'a second click without moving the pointer removes nothing',
    `4 → ${afterOne} → ${afterTwo}`,
  );

  // And a deliberate move re-arms it immediately.
  await page.mouse.move(target.x + 220, target.y + 140);
  await page.waitForTimeout(250);
  const first = page.locator('[data-testid=indicator-row]').first();
  await first.hover();
  await page.waitForTimeout(300);
  await first.locator('.ind-btn-danger').click();
  await page.waitForTimeout(600);
  say(
    (await page.locator('[data-testid=indicator-row]').count()) === 2,
    'but moving and aiming again removes the next one at once',
  );

  await clearAll();
  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
