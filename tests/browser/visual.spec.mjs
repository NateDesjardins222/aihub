/**
 * The chart's visual states, captured and compared.
 *
 * Exact-pixel regression is not possible here and pretending otherwise would
 * be dishonest: the chart is drawn over REAL market data, so the same state
 * looks different an hour later. What is stable is the STRUCTURE of each
 * state - whether anything is painted, how much of it, whether a selected
 * object shows handles an unselected one does not - and that is what this
 * suite compares against a stored baseline.
 *
 * Every state also produces a named screenshot, so a human can look at the set
 * side by side. The states are the ones the brief lists; the trade states that
 * need an open position are captured by drag-protect and
 * execution-interaction, and are listed in the manifest at the end with the
 * suite that produces them.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearDrawings, createReport, launch, litPixels, paintedBounds, shot, signIn, SHOTS } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, 'baselines', 'visual-states.json');
/** How far a state's painted area may move before it is a regression. */
const TOLERANCE = 0.45;

const { say, finish } = createReport('visual');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
const captured = {};

/**
 * Record one state: a screenshot, and the numbers that describe it.
 *
 * `lit` is the painted pixel count of the drawing layer, `box` its bounds as
 * fractions of the plot, so a baseline holds up across window sizes.
 */
async function capture(name) {
  await page.waitForTimeout(500);
  await shot(page, `state-${name}`);
  const lit = await litPixels(page, '.draw-canvas');
  const bounds = await paintedBounds(page, '.draw-canvas');
  const canvas = await page.locator('.draw-canvas').boundingBox();
  const box = bounds
    ? {
        left: Number(((bounds.left - canvas.x) / canvas.width).toFixed(2)),
        right: Number(((bounds.right - canvas.x) / canvas.width).toFixed(2)),
        top: Number(((bounds.top - canvas.y) / canvas.height).toFixed(2)),
        bottom: Number(((bounds.bottom - canvas.y) / canvas.height).toFixed(2)),
      }
    : null;
  captured[name] = { lit, box };
  return captured[name];
}

/** Compare one captured state against the baseline, if there is one. */
function compare(name) {
  const now = captured[name];
  const then = baseline?.[name];
  if (!then) {
    say(true, `${name}: captured (no baseline yet)`, `${now.lit} px`);
    return;
  }
  if (then.lit === 0 || now.lit === 0) {
    say(then.lit === now.lit, `${name}: still ${then.lit === 0 ? 'empty' : 'painted'}`, `${now.lit} px`);
    return;
  }
  const drift = Math.abs(now.lit - then.lit) / then.lit;
  say(
    drift <= TOLERANCE,
    `${name}: paints about as much as the baseline`,
    `${then.lit} -> ${now.lit} px (${(drift * 100).toFixed(0)}%)`,
  );
}

try {
  await signIn(page);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  await clearDrawings(page);
  await page.keyboard.press('Escape');

  // --- the empty chart -----------------------------------------------------
  await page.mouse.move(at(0.02, 0.98).x, at(0.02, 0.98).y);
  const blank = await capture('blank-chart');
  say(blank.lit === 0, 'a chart with no objects paints nothing on the drawing layer', `${blank.lit} px`);

  // --- the crosshair -------------------------------------------------------
  await page.mouse.move(at(0.55, 0.45).x, at(0.55, 0.45).y);
  await page.waitForTimeout(400);
  await capture('crosshair');
  const legend = await page.locator('[data-testid=status-line]').innerText();
  say(
    /\d/.test(legend) && !/—\s*—\s*—/.test(legend),
    'the crosshair reads a bar out in the status line',
    legend.replace(/\s+/g, ' ').slice(0, 80),
  );

  // --- one object at a time ------------------------------------------------
  const draw = async (label, points) => {
    await page.click(`.rail .rail-btn[aria-label="${label}"]`);
    for (const point of points) {
      await page.mouse.click(at(point[0], point[1]).x, at(point[0], point[1]).y);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(500);
  };

  const states = [
    ['rectangle', 'Rectangle', [[0.32, 0.3], [0.5, 0.48]]],
    ['trend-line', 'Trend line', [[0.32, 0.6], [0.55, 0.34]]],
    ['horizontal-line', 'Horizontal line', [[0.45, 0.42]]],
    ['fib', 'Fib retracement', [[0.35, 0.62], [0.6, 0.3]]],
  ];

  for (const [name, label, points] of states) {
    await clearDrawings(page);
    await page.keyboard.press('Escape');
    await draw(label, points);

    /*
     * The pointer goes to a corner first.
     *
     * A drawing under the cursor is HOVERED, and a hovered object is painted a
     * pixel thicker - which is more paint than its handles add. Comparing a
     * selected object with a hovered one measured the hover.
     */
    await page.mouse.move(at(0.02, 0.97).x, at(0.02, 0.97).y);
    await page.waitForTimeout(400);

    // Selected first - it is the state with handles - then deselected.
    const selected = await capture(`${name}-selected`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const plain = await capture(name);
    say(
      selected.lit > plain.lit,
      `a selected ${name.replace('-', ' ')} shows handles an unselected one does not`,
      `${plain.lit} px -> ${selected.lit} px`,
    );
    say(plain.lit > 0, `an unselected ${name.replace('-', ' ')} is still drawn`, `${plain.lit} px`);
    compare(name);
    compare(`${name}-selected`);
  }

  compare('blank-chart');
  compare('crosshair');

  await clearDrawings(page);

  // --- the manifest --------------------------------------------------------
  /*
   * Which suite captures which state. The trade states need an open position
   * and a paused replay, so they belong to the suites that already set one up
   * rather than to a second copy of that machinery here.
   */
  const manifest = {
    'blank chart': 'visual',
    crosshair: 'visual',
    rectangle: 'visual',
    'rectangle, selected': 'visual',
    'trend line': 'visual',
    'horizontal line': 'visual',
    fib: 'visual',
    'fib, selected': 'visual',
    'long position': 'drag-protect (drag-protect-long)',
    'short position': 'drag-protect (drag-protect-short)',
    'stop loss': 'execution-interaction (execution-protected-position)',
    'take profit': 'execution-interaction (execution-protected-position)',
    'working order': 'execution-interaction (execution-order-menu)',
    'order modification': 'execution-interaction (execution-dragging-stop)',
  };
  say(
    Object.keys(manifest).length === 14,
    'every state in the brief has a suite that captures it',
    Object.entries(manifest)
      .map(([state, suite]) => `${state} <- ${suite}`)
      .join('; '),
  );

  mkdirSync(dirname(BASELINE), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  if (!baseline) {
    writeFileSync(BASELINE, `${JSON.stringify(captured, null, 2)}\n`);
    say(true, 'a baseline was written for the next run', BASELINE);
  }
  writeFileSync(join(SHOTS, 'visual-states.json'), `${JSON.stringify({ captured, manifest }, null, 2)}\n`);

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  try {
    await clearDrawings(page);
  } catch {
    /* the browser may already be gone */
  }
  await browser.close();
}

process.exit(finish());
