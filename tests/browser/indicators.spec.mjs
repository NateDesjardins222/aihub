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

  // A different colour for the third one, so the chart can be read.
  const colour = page
    .locator('[data-testid=indicator-settings] .st-row:has(.st-row-label:text-is("Colour")) input[type=color]')
    .first();
  await colour.fill('#ff5a5a');
  await colour.dispatchEvent('change');
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

  await clearAll();
  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
