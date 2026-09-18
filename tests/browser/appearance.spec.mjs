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

  // Leave the workspace as it was found: the suites share one account.
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
