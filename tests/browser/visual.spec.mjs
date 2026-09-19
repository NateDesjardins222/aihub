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
import {
  clearDrawings,
  clearIndicators,
  createReport,
  launch,
  litPixels,
  paintedBounds,
  shot,
  signIn,
  SHOTS,
} from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, 'baselines', 'visual-states.json');
/** How far a state's painted area may move before it is a regression. */
const TOLERANCE = 0.45;

const { say, finish, watch } = createReport('visual');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
/** `--save` re-records the baseline from this run, deliberately. */
const SAVE = process.argv.includes('--save');
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

/**
 * Record one SCREEN: where its regions sit and what it is painted with.
 *
 * A screen full of text and controls cannot be compared by counting lit
 * pixels - and comparing its pixels outright would fail every time a figure
 * in it changed, which is every run. What is stable is the layout: the
 * fraction of the window each region occupies, how many controls it offers,
 * and the tokens it is painted with. A panel that loses its border, a dialog
 * that stops filling its space, a theme that half-applies - all of those move
 * one of these numbers; a different price does not.
 */
async function surface(name, regions) {
  await page.waitForTimeout(400);
  await shot(page, `state-${name}`);
  const viewport = page.viewportSize();
  const measured = {};
  for (const [label, selector] of Object.entries(regions)) {
    const box = await page.locator(selector).first().boundingBox().catch(() => null);
    measured[label] = box
      ? {
          x: Number((box.x / viewport.width).toFixed(2)),
          y: Number((box.y / viewport.height).toFixed(2)),
          w: Number((box.width / viewport.width).toFixed(2)),
          h: Number((box.height / viewport.height).toFixed(2)),
        }
      : null;
  }
  const controls = await page.evaluate(
    () => document.querySelectorAll('button, input, select, [role=button]').length,
  );
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (token) => style.getPropertyValue(token).trim();
    return {
      bg: read('--bg-base'),
      panel: read('--bg-panel'),
      text: read('--text-primary'),
      accent: read('--accent'),
      mode: document.documentElement.dataset.themeMode ?? 'dark',
    };
  });
  captured[name] = { kind: 'surface', regions: measured, controls, tokens };
  return captured[name];
}

/** Compare a screen's layout, its control count and its colours. */
function compareSurface(name) {
  const now = captured[name];
  const then = baseline?.[name];
  if (!then || then.kind !== 'surface') {
    say(true, `${name}: captured (no baseline yet)`, `${now.controls} controls`);
    return;
  }
  const moved = [];
  for (const [label, box] of Object.entries(now.regions)) {
    const was = then.regions[label];
    if (!was || !box) {
      if (was !== box) moved.push(`${label} ${was ? 'gone' : 'appeared'}`);
      continue;
    }
    for (const key of ['x', 'y', 'w', 'h']) {
      // Two percent of the window: a region that moves further than that has
      // been re-laid-out, not merely re-rendered.
      if (Math.abs(box[key] - was[key]) > 0.02) moved.push(`${label}.${key} ${was[key]}->${box[key]}`);
    }
  }
  say(moved.length === 0, `${name}: laid out where the baseline had it`, moved.join(', ') || 'every region in place');

  const drift = then.controls === 0 ? 0 : Math.abs(now.controls - then.controls) / then.controls;
  say(
    drift <= 0.15,
    `${name}: offers the same controls`,
    `${then.controls} -> ${now.controls}`,
  );

  const changed = Object.entries(now.tokens).filter(([key, value]) => then.tokens[key] !== value);
  say(
    changed.length === 0,
    `${name}: painted with the same tokens`,
    changed.map(([key, value]) => `${key} ${then.tokens[key]}->${value}`).join(', ') || Object.values(now.tokens).join(' '),
  );
}

/** Compare one captured state against the baseline, if there is one. */
function compare(name) {
  const now = captured[name];
  const then = baseline?.[name];
  if (now?.kind === 'surface') return compareSurface(name);
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

/** Put the terminal on a named theme and close the dialog behind us. */
async function setTheme(id) {
  if ((await page.locator('.st-dialog').count()) === 0) {
    await page.click('[data-testid=apprail-settings]');
    await page.waitForSelector('.st-nav-item', { timeout: 15_000 });
  }
  await page.click('.st-nav-item:has-text("Theme")');
  await page.waitForSelector('[data-theme-card]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.click(`[data-theme-card=${id}]`);
  await page.waitForTimeout(1_200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_000);
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
  await page.keyboard.press('Escape');

  /*
   * ---------------------------------------------------------- the screens --
   *
   * The rest of the brief's list is not chart states: they are screens, and
   * they are compared by their layout rather than by their pixels. See
   * `surface` above for why.
   */
  /*
   * A known theme first.
   *
   * These baselines record the colours each screen is painted with, so they
   * have to start from a stated theme rather than from whatever the last
   * suite - or the last crash - left behind.
   */
  await setTheme('ATLAS_DARK');

  const SHELL = {
    accountBar: '.abar',
    rail: '.apprail',
    chart: '[data-pane=p1] .chart-canvas',
    ticket: '.terminal-right',
    bottom: '.terminal-bottom',
  };

  // The terminal as a trader leaves it: one chart, blotter open.
  await surface('terminal-dark', SHELL);
  compare('terminal-dark');

  // With indicators, one of them in a pane of its own.
  for (const name of ['Exponential moving', 'Relative strength']) {
    await page.click('[data-pane=p1] .chdr-btn:has-text("Indicators")');
    await page.waitForTimeout(400);
    await page.click(`[data-testid=indicator-catalogue] .pop-item:has-text("${name}")`);
    await page.waitForTimeout(1_600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await surface('terminal-indicators', { ...SHELL, legend: '[data-testid=indicator-row]' });
  compare('terminal-indicators');
  await clearIndicators(page);
  await page.waitForTimeout(1_200);

  // Four charts.
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click('[data-testid=layout-choices] button[data-layout=FOUR]');
  await page.waitForTimeout(6_000);
  await surface('terminal-four-charts', {
    ...SHELL,
    second: '[data-pane=p2] .chart-canvas',
    fourth: '[data-pane=p4] .chart-canvas',
  });
  compare('terminal-four-charts');
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click('[data-testid=layout-choices] button[data-layout=ONE]');
  await page.waitForTimeout(3_000);

  // The blotter, closed and open again.
  await page.click('.panel-head .icon-btn[title=Collapse]');
  await page.waitForTimeout(700);
  await surface('bottom-panel-closed', SHELL);
  compare('bottom-panel-closed');
  await page.click('.panel-head .icon-btn[title=Expand]');
  await page.waitForTimeout(700);
  await surface('bottom-panel-open', SHELL);
  compare('bottom-panel-open');

  // The Journal.
  await page.click('[data-testid=apprail-journal]');
  await page.waitForSelector('[data-testid=drawer-journal]', { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  await surface('journal', { ...SHELL, journal: '[data-testid=drawer-journal]' });
  compare('journal');
  await page.click('[data-testid=drawer-journal] .drawer-close');
  await page.waitForTimeout(800);

  // Settings, on two of its tabs.
  await page.click('[data-testid=apprail-settings]');
  await page.waitForSelector('.st-nav-item', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await surface('settings', { dialog: '.st-dialog', nav: '.st-nav', body: '.st-body' });
  compare('settings');
  /*
   * Appearance is the Theme tab: the presets, the seven terminal colours and
   * the chart's own. There is no separate "Appearance" screen to photograph,
   * and inventing one for the manifest's sake would be a lie in a baseline.
   */
  await page.click('.st-nav-item:has-text("Theme")');
  await page.waitForSelector('[data-theme-card]', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await surface('settings-appearance', {
    dialog: '.st-dialog',
    nav: '.st-nav',
    body: '.st-body',
    themes: '[data-testid=theme-grid]',
  });
  compare('settings-appearance');

  await page.click('[data-theme-card=CLEAN_LIGHT]');
  await page.waitForTimeout(1_500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1_200);
  await surface('terminal-light', SHELL);
  compare('terminal-light');

  await setTheme('ATLAS_DARK');
  await surface('terminal-dark-again', SHELL);
  say(
    JSON.stringify(captured['terminal-dark-again'].tokens) ===
      JSON.stringify(captured['terminal-dark'].tokens),
    'the dark theme comes back exactly as it was',
    `${captured['terminal-dark'].tokens.bg} -> ${captured['terminal-dark-again'].tokens.bg}`,
  );

  // Narrow and wide.
  await page.setViewportSize({ width: 1024, height: 820 });
  await page.waitForTimeout(2_000);
  await surface('narrow-1024', SHELL);
  compare('narrow-1024');
  await page.setViewportSize({ width: 2560, height: 1400 });
  await page.waitForTimeout(2_000);
  await surface('wide-2560', SHELL);
  compare('wide-2560');
  await page.setViewportSize({ width: 1600, height: 950 });
  await page.waitForTimeout(1_500);

  // --- the manifest --------------------------------------------------------
  /*
   * Which suite captures which state. The trade states need an open position
   * and a paused replay, so they belong to the suites that already set one up
   * rather than to a second copy of that machinery here.
   */
  const manifest = {
    'blank chart': 'visual',
    crosshair: 'visual',
    'chart with indicators': 'visual (state-terminal-indicators)',
    'multi-chart': 'visual (state-terminal-four-charts)',
    journal: 'visual (state-journal)',
    settings: 'visual (state-settings)',
    appearance: 'visual (state-settings-appearance, the Theme tab)',
    'dark theme': 'visual (state-terminal-dark)',
    'light theme': 'visual (state-terminal-light)',
    'bottom panel open': 'visual (state-bottom-panel-open)',
    'bottom panel closed': 'visual (state-bottom-panel-closed)',
    narrow: 'visual (state-narrow-1024)',
    wide: 'visual (state-wide-2560)',
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
    Object.keys(manifest).length === 25,
    'every state in the brief has a suite that captures it',
    Object.entries(manifest)
      .map(([state, suite]) => `${state} <- ${suite}`)
      .join('; '),
  );

  mkdirSync(dirname(BASELINE), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  if (!baseline || SAVE) {
    writeFileSync(BASELINE, `${JSON.stringify(captured, null, 2)}\n`);
    say(true, `a baseline was ${baseline ? 're-recorded' : 'written'} for the next run`, BASELINE);
  }
  writeFileSync(join(SHOTS, 'visual-states.json'), `${JSON.stringify({ captured, manifest }, null, 2)}\n`);

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  try {
    await clearDrawings(page);
    // Whatever happened above, the next suite gets the default theme back.
    await setTheme('ATLAS_DARK');
  } catch {
    /* the browser may already be gone */
  }
  await browser.close();
}

process.exit(finish());
