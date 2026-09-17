/**
 * Drawings, indicators and whether settings actually persist.
 *
 * The drawing checks read the canvas rather than the DOM, because a drawing
 * that is in the store but not painted is not a drawing.
 */
import { createReport, launch, litPixels, shot, signIn } from './harness.mjs';

const { say, finish } = createReport('tools');
const { browser, page, errors } = await launch();

try {
  await signIn(page);

  const canvas = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: canvas.x + canvas.width * fx, y: canvas.y + canvas.height * fy });

  const clear = page.locator('.rail .rail-btn[aria-label="Remove all drawings"]');
  if (await clear.count()) {
    await clear.click();
    await page.waitForTimeout(600);
  }

  // Indicators persist, so a previous run's are removed first.
  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(500);
  for (let i = 0; i < 12; i += 1) {
    const remove = page.locator('.chdr-ind-row .chdr-ind-btn[title=Remove]').first();
    if (!(await remove.count())) break;
    await remove.click();
    await page.waitForTimeout(350);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // --- drawings ------------------------------------------------------------
  const railButtons = await page.locator('.rail .rail-btn').count();
  say(railButtons <= 10, 'the rail shows a handful of tools, not a wall', `${railButtons} buttons`);

  await page.click('.rail .rail-btn[aria-label="Trend line"]');
  say(
    await page.locator('.rail .rail-btn[aria-label="Trend line"]').evaluate((n) => n.classList.contains('rail-btn-on')),
    'picking a tool arms it',
  );

  const a = at(0.3, 0.35);
  const b = at(0.55, 0.62);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(700);
  const drawn = await litPixels(page);
  say(drawn > 200, 'a trend line is painted', `${drawn} lit pixels`);
  say((await page.locator('.rail .rail-btn[aria-label="Lock"]').count()) === 1, 'the new object is selected');

  const middle = at(0.425, 0.485);
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 60, middle.y - 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  say((await litPixels(page)) > 200, 'it survives being dragged');

  await page.click('.rail .rail-btn[aria-label="Hide"]');
  await page.waitForTimeout(500);
  say((await litPixels(page)) === 0, 'hiding removes it from the canvas');
  await page.click('.rail .rail-btn[aria-label="Hide"]');
  await page.waitForTimeout(400);

  await page.click('.rail .rail-btn[aria-label="Lock"]');
  await page.waitForTimeout(400);
  say(await page.locator('.rail .rail-btn[aria-label="Delete"]').isDisabled(), 'a locked object cannot be deleted');
  await page.click('.rail .rail-btn[aria-label="Lock"]');
  await page.waitForTimeout(400);

  say(
    await page.locator('.rail .rail-btn[aria-label=Magnet]').evaluate((n) => n.classList.contains('rail-btn-on')),
    'the magnet is on by default',
  );

  const withLine = await litPixels(page);
  await page.click('.rail .rail-btn[aria-label="Fib retracement"]');
  await page.mouse.click(at(0.62, 0.3).x, at(0.62, 0.3).y);
  await page.mouse.click(at(0.8, 0.55).x, at(0.8, 0.55).y);
  await page.waitForTimeout(700);
  say((await litPixels(page)) > withLine, 'a fib retracement draws its levels');
  await shot(page, 'tools-drawings');

  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  say((await page.locator('.rail .rail-btn[aria-label="Lock"]').count()) === 0, 'Delete removes the selection');

  // --- indicators ----------------------------------------------------------
  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(500);
  const catalogue = await page.locator('.popover .pop-item').allTextContents();
  say(catalogue.length >= 8, 'one searchable menu lists the catalogue', `${catalogue.length} entries`);
  await page.fill('.popover .pop-search', 'rsi');
  await page.waitForTimeout(400);
  const filtered = await page.locator('.popover .pop-item').allTextContents();
  say(filtered.length === 1 && /Relative strength/.test(filtered[0]), 'the search filters it', filtered.join(' / '));
  await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Relative strength")');
  await page.waitForTimeout(3_000);

  const status = ((await page.textContent('[data-testid=status-line]')) ?? '').replace(/\s+/g, ' ');
  const rsi = Number(status.match(/RSI 14\s*([\d.]+)/)?.[1] ?? NaN);
  say(Number.isFinite(rsi) && rsi >= 0 && rsi <= 100, 'RSI computes a value inside 0-100', String(rsi));

  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(400);
  await page.fill('.popover .pop-search', 'moving');
  await page.waitForTimeout(400);
  await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Moving average")');
  await page.waitForTimeout(3_000);
  const status2 = ((await page.textContent('[data-testid=status-line]')) ?? '').replace(/\s+/g, ' ');
  const ma = Number(status2.match(/MA 20\s*([\d.]+)/)?.[1] ?? NaN);
  const last = Number(((await page.textContent('.sl-price')) ?? '').trim());
  say(
    Number.isFinite(ma) && Math.abs(ma - last) / last < 0.05,
    'the moving average sits near the price rather than being nonsense',
    `MA ${ma} vs last ${last}`,
  );
  await shot(page, 'tools-indicators');

  // --- settings and persistence -------------------------------------------
  await page.click('.abar-icon[aria-label=Settings]');
  await page.waitForTimeout(600);
  const sections = await page.locator('.st-nav-item').allTextContents();
  say(
    ['Symbol', 'Status line', 'Scales and lines', 'Canvas'].every((s) => sections.includes(s)),
    'settings carries the four chart sections',
    sections.slice(0, 4).join(' / '),
  );

  await page.click('.st-nav-item:text-is("Symbol")');
  await page.waitForTimeout(400);
  const colour = page.locator('.st-row:has-text("Up colour") .st-colour-text');
  await colour.fill('#8fd0ff');
  await colour.press('Enter');
  await page.waitForTimeout(500);
  await page.click('.st-nav-item:text-is("Time and format")');
  await page.click('.st-choice-btn:text-is("24-hour")');
  await page.waitForTimeout(1_800);
  await page.click('.st-close');
  await page.waitForTimeout(1_500);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(4_500);
  await page.click('.abar-icon[aria-label=Settings]');
  await page.waitForTimeout(700);
  say(
    (await page.locator('.st-row:has-text("Up colour") .st-colour-text').inputValue()) === '#8fd0ff',
    'a chart colour survives a reload',
  );
  await page.click('.st-nav-item:text-is("Time and format")');
  await page.waitForTimeout(400);
  say(
    await page.locator('.st-choice-btn:text-is("24-hour")').evaluate((n) => n.classList.contains('st-choice-on')),
    'the clock format survives a reload',
  );

  const restored = ((await page.textContent('[data-testid=status-line]')) ?? '').replace(/\s+/g, ' ');
  say(/RSI 14/.test(restored) && /MA 20/.test(restored), 'the indicators survive a reload too');

  // Put everything back so the next run starts clean.
  await page.click('.st-choice-btn:text-is("12-hour")');
  await page.click('.st-nav-item:text-is("Canvas")');
  await page.click('.st-actions button:text-is("Reset to defaults")');
  await page.click('.st-danger');
  await page.waitForTimeout(700);
  await page.click('.st-close');
  await page.waitForTimeout(1_000);

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
