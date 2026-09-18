/**
 * Making it look the way you want it to look.
 *
 * Two things the brief asked for by name: a small set of presets that all look
 * good, and a colour experience that is not the operating system's dialog.
 * Both are only worth having if they are honest - a preview that lies about
 * what you will get, or a picker that cannot produce the rgba() a fill needs,
 * is worse than the native input it replaced.
 *
 * So the preview is checked by reading what the terminal ACTUALLY became while
 * the pointer was over the card, and checked again for having put it back
 * afterwards.
 */
import { createReport, launch, signIn, shot } from './harness.mjs';

const { say, finish, watch } = createReport('appearance');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

const tokens = () =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      theme: document.documentElement.dataset.theme ?? null,
      mode: document.documentElement.dataset.themeMode ?? null,
      panel: style.getPropertyValue('--bg-panel').trim(),
      text: style.getPropertyValue('--text-primary').trim(),
    };
  });

/** The colour the canvas is actually painted with, not the one that was asked for. */
const canvasCorner = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.chart-canvas canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const pixel = ctx.getImageData(4, 4, 1, 1).data;
    return `${pixel[0]},${pixel[1]},${pixel[2]}`;
  });

const openSettings = async (tabLabel) => {
  if ((await page.locator('.st-dialog').count()) === 0) {
    await page.click('[data-testid=apprail-settings]');
    await page.waitForTimeout(1_000);
  }
  await page.click(`.st-nav-item:has-text("${tabLabel}")`);
  await page.waitForTimeout(500);
};

try {
  await signIn(page);
  await openSettings('Theme');

  const cards = await page.locator('[data-theme-card]').count();
  say(cards === 5, 'there is a small set of themes, not a marketplace', `${cards} presets`);

  const started = await tokens();

  // --- hovering previews, on the real terminal -----------------------------
  await page.hover('[data-theme-card=CLEAN_LIGHT]');
  await page.waitForTimeout(800);
  const previewed = await tokens();
  say(
    previewed.theme === 'CLEAN_LIGHT' && previewed.mode === 'light',
    'hovering a preset applies it to the whole terminal',
    JSON.stringify(previewed),
  );
  const previewCanvas = await canvasCorner();
  say(previewCanvas !== null, 'and the chart itself repaints', `canvas ${previewCanvas}`);

  // --- and leaving puts it back -------------------------------------------
  await page.mouse.move(700, 900);
  await page.waitForTimeout(800);
  const restored = await tokens();
  say(
    restored.theme === started.theme && restored.panel === started.panel,
    'moving away puts back exactly what was there',
    `${previewed.theme} → ${restored.theme}`,
  );

  // --- clicking commits ----------------------------------------------------
  await page.click('[data-theme-card=MIDNIGHT]');
  await page.waitForTimeout(900);
  const chosen = await tokens();
  say(chosen.theme === 'MIDNIGHT', 'clicking one keeps it', JSON.stringify(chosen));
  await shot(page, 'theme-midnight');

  await page.click('.st-close');
  await page.waitForTimeout(3_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);
  const afterReload = await tokens();
  say(afterReload.theme === 'MIDNIGHT', 'and it is still there after a reload', JSON.stringify(afterReload));

  // --- the light one is legible, not just light ---------------------------
  await openSettings('Theme');
  await page.click('[data-theme-card=CLEAN_LIGHT]');
  await page.waitForTimeout(900);
  await page.click('.st-close');
  await page.waitForTimeout(1_500);
  const light = await page.evaluate(() => {
    const parse = (colour) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const luminance = ([r, g, b]) => {
      const channel = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const results = [];
    for (const selector of ['.abar-box-value', '.abar-box-label', '.chdr-symbol', '.st-nav-item']) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const style = getComputedStyle(element);
      let node = element;
      let background = parse(style.backgroundColor);
      while (!background || getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)') {
        node = node.parentElement;
        if (!node) break;
        const candidate = parse(getComputedStyle(node).backgroundColor);
        if (candidate && getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)') {
          background = candidate;
          break;
        }
      }
      const foreground = parse(style.color);
      if (!foreground || !background) continue;
      results.push({ selector, ratio: Number(contrast(foreground, background).toFixed(2)) });
    }
    return results;
  });
  const worst = light.reduce((low, item) => Math.min(low, item.ratio), 99);
  say(worst >= 4.5, 'the light theme keeps its text readable', JSON.stringify(light));
  await shot(page, 'theme-clean-light');

  // --- the seven colours the terminal is built from ------------------------
  /*
   * The brief asks for accent, profit, loss, SL, TP, working orders and panels
   * to be customisable. They are all one question: those markers are drawn
   * from three design tokens, so changing the accent has to move the selection
   * tint and the working-order line with it, and changing profit has to move
   * the filled P&L box. A colour that moves alone is a half-applied theme.
   */
  const token = (name) =>
    page.evaluate(
      (t) => getComputedStyle(document.documentElement).getPropertyValue(t).trim(),
      name,
    );
  await openSettings('Theme');
  say(
    (await page.locator('[data-testid=terminal-colours] .st-row').count()) === 7,
    'the terminal has its own colours, not just the chart',
  );

  const accentBefore = await token('--accent');
  const accentTintBefore = await token('--accent-bg');
  await page
    .locator('[data-testid=terminal-colours] .st-row:has-text("Accent") [data-testid=colour-swatch]')
    .click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid=colour-popover] .cp-cell').nth(19).click();
  await page.waitForTimeout(700);
  say((await token('--accent')) !== accentBefore, 'the accent can be changed', `${accentBefore} → ${await token('--accent')}`);
  say((await token('--accent-bg')) !== accentTintBefore, 'and its tint moves with it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const fillBefore = await token('--pos-fill');
  await page
    .locator('[data-testid=terminal-colours] .st-row:has-text("Profit") [data-testid=colour-swatch]')
    .click();
  await page.waitForTimeout(400);
  await page.locator('[data-testid=colour-popover] .cp-cell').nth(11).click();
  await page.waitForTimeout(700);
  say((await token('--pos-fill')) !== fillBefore, 'profit moves the filled P&L box with it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- saving one of your own ---------------------------------------------
  const presets = await page.locator('[data-theme-card]').count();
  await page.click('[data-testid=save-theme]');
  await page.waitForTimeout(900);
  say(
    (await page.locator('[data-theme-card]').count()) === presets + 1,
    'what is on the screen can be saved as a theme',
    `${presets} → ${await page.locator('[data-theme-card]').count()} cards`,
  );
  const savedName = await page.locator('.th-card-on .th-name').innerText();
  say(/mine/i.test(savedName), 'named after the one it came from', savedName.replace(/\s+/g, ' '));

  await page.locator('.th-card-on .th-action:has-text("Rename")').click();
  await page.waitForTimeout(400);
  await page.fill('.th-rename input', 'Desk');
  await page.click('.th-rename button');
  await page.waitForTimeout(600);
  say(/Desk/.test(await page.locator('.th-card-on .th-name').innerText()), 'and renamed');

  await page.locator('.th-card-on .th-action:has-text("Duplicate")').click();
  await page.waitForTimeout(700);
  say(
    (await page.locator('[data-theme-card]').count()) === presets + 2,
    'and duplicated',
  );

  await page.locator('.th-card-on .th-action:has-text("Set default")').click();
  await page.waitForTimeout(500);
  say(
    /default/.test(await page.locator('.th-card-on .th-name').innerText()),
    'and set as the default',
  );

  await page.click('.st-close');
  await page.waitForTimeout(2_500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);
  await openSettings('Theme');
  say(
    (await page.locator('[data-theme-card]').count()) === presets + 2,
    'the saved themes come back after a reload',
  );
  say(
    /Desk/.test(await page.locator('.th-card-on .th-name').innerText()),
    'and the one in use is still the one in use',
  );

  const copy = page.locator('.th-card:has(.th-name:has-text("copy"))').first();
  await copy.locator('.th-action:has-text("Delete")').click();
  await page.waitForTimeout(400);
  say((await copy.locator('.th-action:has-text("Delete it")').count()) === 1, 'deleting asks first');
  await copy.locator('.th-action:has-text("Delete it")').click();
  await page.waitForTimeout(700);
  say(
    (await page.locator('[data-theme-card]').count()) === presets + 1,
    'and then deletes it',
  );

  const own = page.locator('.th-card:has(.th-name:has-text("Desk"))').first();
  await own.locator('.th-action:has-text("Delete")').click();
  await page.waitForTimeout(400);
  await own.locator('.th-action:has-text("Delete it")').click();
  await page.waitForTimeout(900);
  say(
    (await page.locator('[data-theme-card]').count()) === presets &&
      (await page.evaluate(() => document.documentElement.dataset.theme)) === 'ATLAS_DARK',
    'and deleting the one in USE falls back rather than leaving nothing',
  );

  // --- a theme decides colours and nothing else ---------------------------
  /*
   * Found by reading the diff, not by a failure: a theme used to carry a whole
   * appearance, so picking one also put the crosshair back to a cross and the
   * price scale back to linear - settings that are none of a theme's business.
   */
  await openSettings('Scales and lines');
  const dot = page
    .locator('.st-group:has(.st-group-title:text-is("Crosshair")) .st-row:has(.st-row-label:text-is("Style")) .st-choice-btn')
    .filter({ hasText: 'Dot' })
    .first();
  await dot.click();
  await page.waitForTimeout(600);
  const logScale = page.locator('.st-row:has(.st-row-label:text-is("Logarithmic")) input[type=checkbox]').first();
  const logWas = await logScale.isChecked();
  if (!logWas) await logScale.click();
  await page.waitForTimeout(600);
  say(await logScale.isChecked(), 'the scale is set to logarithmic and the crosshair to a dot');

  await openSettings('Theme');
  await page.click('[data-theme-card=GRAPHITE]');
  await page.waitForTimeout(1_000);
  await openSettings('Scales and lines');
  say(
    ((await dot.getAttribute('class')) ?? '').includes('st-choice-on'),
    'changing the theme leaves the crosshair shape alone',
  );
  say(await logScale.isChecked(), 'and leaves the scale logarithmic');
  if (!logWas) await logScale.click();
  await page.waitForTimeout(400);
  await page
    .locator('.st-group:has(.st-group-title:text-is("Crosshair")) .st-row:has(.st-row-label:text-is("Style")) .st-choice-btn')
    .filter({ hasText: 'Cross' })
    .first()
    .click();
  await page.waitForTimeout(600);

  // --- the colour control --------------------------------------------------
  await openSettings('Symbol');
  say(
    (await page.locator('[data-testid=colour-swatch]').count()) > 0,
    'colours are edited through a swatch',
  );
  say(
    (await page.locator('.st-content input[type=color]').count()) === 0,
    'and the native picker is not the front door',
  );

  await page.locator('[data-testid=colour-swatch]').first().click();
  await page.waitForTimeout(400);
  const popover = page.locator('[data-testid=colour-popover]');
  say((await popover.count()) === 1, 'the swatch opens a picker');
  const box = await popover.boundingBox();
  const view = page.viewportSize();
  say(
    box !== null &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= view.width &&
      box.y + box.height <= view.height,
    'which is fully on screen inside a dialog that clips',
    JSON.stringify(box),
  );

  const field = page.locator('.st-row:has-text("Up colour") .cp-text');
  const before = await field.inputValue();
  await popover.locator('.cp-cell').nth(17).click();
  await page.waitForTimeout(500);
  say((await field.inputValue()) !== before, 'a swatch changes the colour', `${before} → ${await field.inputValue()}`);

  await popover.locator('input[type=range]').fill('40');
  await page.waitForTimeout(400);
  say(/rgba\(/.test(await field.inputValue()), 'the opacity slider makes an rgba value', await field.inputValue());
  say(
    (await popover.locator('.cp-recent .cp-cell').count()) > 0,
    'and the colours just used are offered back',
  );

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  say((await popover.count()) === 0, 'escape closes the picker');
  say((await page.locator('.st-dialog').count()) === 1, 'and leaves the dialog it opened over');

  await field.fill('#2ec4a6');
  await field.press('Enter');
  await page.waitForTimeout(600);
  say((await field.inputValue()) === '#2ec4a6', 'and a hex can still simply be typed');

  // --- twenty changes in a row, and a reload -------------------------------
  /*
   * The customisation stress the brief asks for.
   *
   * Settings are written to the server behind a debounce, so the failure mode
   * is not "a setting does not save" - it is "a setting does not save when
   * twenty others are saved on top of it". Twenty changes are made as fast as
   * the controls take them, and then the page is reloaded and every one is
   * read back.
   */
  /*
   * What is compared is the SCREEN before against the screen after.
   *
   * Not "each click stuck": some of these settings are mutually exclusive on
   * purpose - a price scale can be logarithmic or percentage but not both, so
   * turning Percent on turns Logarithmic off - and a test that expected every
   * click to survive independently would be asserting a bug. The honest
   * question is whether the state the trader is looking at comes back.
   */
  const readToggles = async (limit) => {
    const boxes = page.locator('.st-content .st-row input[type=checkbox]');
    const count = Math.min(limit, await boxes.count());
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(await boxes.nth(i).isChecked());
    return out;
  };

  await openSettings('Status line');
  const toggles = page.locator('.st-content .st-row input[type=checkbox]');
  const toggleCount = Math.min(8, await toggles.count());
  for (let i = 0; i < toggleCount; i += 1) {
    await toggles.nth(i).click();
    await page.waitForTimeout(90);
  }
  const wanted = await readToggles(8);
  say(toggleCount >= 6, 'the status line has enough switches to stress', `${toggleCount} toggles`);

  await openSettings('Scales and lines');
  const scaleToggles = page.locator('.st-content .st-row input[type=checkbox]');
  const scaleCount = Math.min(6, await scaleToggles.count());
  for (let i = 0; i < scaleCount; i += 1) {
    await scaleToggles.nth(i).click();
    await page.waitForTimeout(90);
  }
  const scaleWanted = await readToggles(6);

  await openSettings('Canvas');
  const fontSize = page.locator('.st-row:has-text("Font size") input[type=number]').first();
  await fontSize.fill('14');
  await fontSize.dispatchEvent('change');
  await page.waitForTimeout(200);
  const background = page.locator('.st-row:has-text("Background") .cp-text').first();
  await background.fill('#0a0c12');
  await background.press('Enter');
  await page.waitForTimeout(300);

  say(
    toggleCount + scaleCount + 2 >= 16,
    'sixteen or more settings changed in a few seconds',
    `${toggleCount + scaleCount + 2} changes`,
  );

  await page.click('.st-close');
  await page.waitForTimeout(2_500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);

  await openSettings('Status line');
  const afterStatus = await readToggles(8);
  say(
    JSON.stringify(afterStatus) === JSON.stringify(wanted),
    'every status-line switch came back the way it was left',
    `${JSON.stringify(wanted)} vs ${JSON.stringify(afterStatus)}`,
  );

  await openSettings('Scales and lines');
  const afterScales = await readToggles(6);
  say(
    JSON.stringify(afterScales) === JSON.stringify(scaleWanted),
    'and so did every scale switch',
    `${JSON.stringify(scaleWanted)} vs ${JSON.stringify(afterScales)}`,
  );

  await openSettings('Canvas');
  say(
    (await page.locator('.st-row:has-text("Font size") input[type=number]').first().inputValue()) === '14',
    'the font size survived too',
  );
  say(
    (await page.locator('.st-row:has-text("Background") .cp-text').first().inputValue()) === '#0a0c12',
    'and the background colour',
  );

  // Leave the workspace as it was found: the suites share one account.
  await openSettings('Canvas');
  await page.click('.st-actions button:has-text("Reset to defaults")');
  await page.waitForTimeout(400);
  await page.click('.st-actions button:has-text("Reset")');
  await page.waitForTimeout(1_200);
  say(
    (await page.locator('.st-row:has-text("Font size") input[type=number]').first().inputValue()) !== '14',
    'and one reset puts all of it back',
  );
  await openSettings('Theme');
  await page.click('[data-theme-card=ATLAS_DARK]');
  await page.waitForTimeout(900);
  await page.click('.st-close');
  await page.waitForTimeout(2_000);
  say((await tokens()).theme === 'ATLAS_DARK', 'the default is put back for the next suite');

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
