/**
 * Drawings, indicators and whether settings actually persist.
 *
 * The drawing checks read the canvas rather than the DOM, because a drawing
 * that is in the store but not painted is not a drawing.
 */
import { clearDrawings, createReport, launch, litPixels, shot, signIn, useSymbol } from './harness.mjs';

const { say, finish, watch } = createReport('tools');
const { browser, page, errors } = await launch();
watch(page);

try {
  await signIn(page);
  // This suite trades NQ, so the ticket has to be pointed at NQ.
  await useSymbol(page, 'NQ');

  const canvas = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: canvas.x + canvas.width * fx, y: canvas.y + canvas.height * fy });

  await clearDrawings(page);

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
  /*
   * A handful of TOOLS on show, with the rest behind the chevron.
   *
   * Counting every button in the rail counted the cursor, the sticky-mode pin,
   * the magnet, the object tree and undo/redo as drawing tools, so adding one
   * mode toggle read as the rail growing into a wall. The tools carry
   * data-rail="tool"; the second check keeps the rail as a whole compact, so
   * the first one cannot be satisfied by moving a tool into a mode.
   */
  const railTools = await page.locator('.rail .rail-btn[data-rail=tool]').count();
  say(railTools <= 8, 'the rail shows a handful of tools, not a wall', `${railTools} tools`);
  const railButtons = await page.locator('.rail .rail-btn').count();
  say(
    railButtons <= 14,
    'and the rail as a whole stays narrow enough to scan',
    `${railButtons} buttons in total`,
  );

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
  say((await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) === 1, 'the new object is selected');
  // The rail is a TOOL bar: selecting an object must not grow it.
  say(
    (await page.locator('.rail .rail-btn').count()) === railButtons,
    'the rail stays the same size with an object selected',
  );

  const middle = at(0.425, 0.485);
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down();
  await page.mouse.move(middle.x + 60, middle.y - 40, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  say((await litPixels(page)) > 200, 'it survives being dragged');

  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(350);
  await page.locator('[data-testid=object-tree-row] .ot-btn').first().click();
  await page.waitForTimeout(500);
  say((await litPixels(page)) === 0, 'hiding removes it from the canvas');
  await page.locator('[data-testid=object-tree-row] .ot-btn').first().click();
  await page.waitForTimeout(400);
  // Closed by the same button rather than by Escape, which would also clear
  // the selection the next step needs.
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(300);

  await page.click('[data-testid=drawing-style-bar] button[aria-label="Lock object"]');
  await page.waitForTimeout(400);
  say(
    await page.locator('[data-testid=drawing-style-bar] button[aria-label="Delete object"]').isDisabled(),
    'a locked object cannot be deleted',
  );
  await page.click('[data-testid=drawing-style-bar] button[aria-label="Lock object"]');
  await page.waitForTimeout(400);

  say(
    await page.locator('.rail .rail-btn[aria-label=Magnet]').evaluate((n) => n.classList.contains('rail-btn-on')),
    'the magnet is on by default',
  );

  /*
   * The three magnet modes, by behaviour.
   *
   * With the magnet OFF an anchor goes exactly where it was clicked, so two
   * clicks three pixels apart are two different prices. With it STRONG the
   * anchor is pulled to a price the bar actually printed, so the same two
   * clicks land on the same price. That is the difference a trader feels, and
   * it is checked rather than the button's label.
   */
  const magnetButton = page.locator('.rail .rail-btn[aria-label=Magnet]');
  const mode = () => magnetButton.getAttribute('data-magnet');
  const setMagnet = async (wanted) => {
    for (let i = 0; i < 4; i += 1) {
      if ((await mode()) === wanted) return true;
      await magnetButton.click();
      await page.waitForTimeout(250);
    }
    return (await mode()) === wanted;
  };

  const seen = [await mode()];
  for (let i = 0; i < 2; i += 1) {
    await magnetButton.click();
    await page.waitForTimeout(250);
    seen.push(await mode());
  }
  say(
    new Set(seen).size === 3 && seen.every((m) => ['OFF', 'WEAK', 'STRONG'].includes(m)),
    'the magnet cycles through off, weak and strong',
    seen.join(' -> '),
  );

  /** Place one horizontal line at a pixel and read the price it anchored to. */
  const priceAt = async (fy) => {
    await clearDrawings(page);
    await page.keyboard.press('Escape');
    await page.click('.rail .rail-btn[aria-label="Horizontal line"]');
    await page.mouse.click(at(0.5, fy).x, at(0.5, fy).y);
    await page.waitForTimeout(500);
    await page.click('.rail .rail-btn[aria-label="Object tree"]');
    await page.waitForTimeout(350);
    const detail = await page.locator('[data-testid=object-tree-row] .ot-detail').first().innerText();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    return detail.trim();
  };

  const plotHeight = canvas.height;
  const nudge = 4 / plotHeight;
  say(await setMagnet('OFF'), 'the magnet can be turned off', await mode());
  const looseA = await priceAt(0.44);
  const looseB = await priceAt(0.44 + nudge);
  say(
    looseA !== looseB,
    'with the magnet off an anchor goes exactly where it was clicked',
    `${looseA} vs ${looseB}`,
  );

  say(await setMagnet('STRONG'), 'the magnet can be set to strong', await mode());
  const snappedA = await priceAt(0.44);
  const snappedB = await priceAt(0.44 + nudge);
  say(
    snappedA === snappedB,
    'with it strong both clicks snap to the same printed price',
    `${snappedA} vs ${snappedB}`,
  );
  // And it is a price the market actually printed - checked against the bars
  // the server served, not against the anchor the click produced.
  const printed = await page.evaluate(async () => {
    const refreshToken = window.localStorage.getItem('atlas.refreshToken');
    const session = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).then((r) => r.json());
    window.localStorage.setItem('atlas.refreshToken', session.refreshToken);
    const timeframe = window.localStorage.getItem('atlas.chart.timeframe') ?? '1m';
    const bars = await fetch(
      // Deep enough to include whatever bar the click landed on: earlier steps
      // in this suite pan and zoom, so the middle of the plot is not
      // necessarily inside the most recent few hundred bars.
      `/api/v1/marketdata/bars?symbol=NQ&timeframe=${timeframe}&limit=5000`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
    ).then((r) => r.json());
    const values = new Set();
    for (const bar of bars.bars ?? []) {
      for (const value of [bar.open, bar.high, bar.low, bar.close]) values.add(value);
    }
    return [...values];
  });
  const snapped = Number(snappedA.replace(/[^0-9.]/g, ''));
  say(
    printed.some((value) => Math.abs(value - snapped) < 0.005),
    'and that price is one the bars printed, not an interpolation',
    `${snappedA} found among ${printed.length} printed prices`,
  );

  await setMagnet('WEAK');
  await clearDrawings(page);
  await page.keyboard.press('Escape');

  const withLine = await litPixels(page);
  await page.click('.rail .rail-btn[aria-label="Fib retracement"]');
  await page.mouse.click(at(0.62, 0.3).x, at(0.62, 0.3).y);
  await page.mouse.click(at(0.8, 0.55).x, at(0.8, 0.55).y);
  await page.waitForTimeout(700);
  say((await litPixels(page)) > withLine, 'a fib retracement draws its levels');
  await shot(page, 'tools-drawings');

  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  say((await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) === 0, 'Delete removes the selection');

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

  // Read from the LEGEND ROWS, which is where an indicator's value lives now.
  const rowText = async () =>
    (await page.locator('[data-testid=indicator-row]').allTextContents())
      .join(' | ')
      .replace(/\s+/g, ' ');

  /*
   * Wait for the VALUE, not for the clock.
   *
   * A fixed sleep after adding an indicator was passing on a fast machine and
   * reporting NaN on a slow one, and "NaN" says nothing about whether the
   * indicator is broken or the row had simply not rendered yet. This waits for
   * the row to carry a number and hands back the raw text either way, so a
   * real failure names what was on screen.
   */
  const valueOf = async (pattern, tries = 20) => {
    let text = '';
    for (let i = 0; i < tries; i += 1) {
      await page.waitForTimeout(600);
      text = await rowText();
      const found = text.match(pattern)?.[1];
      if (found !== undefined) return { value: Number(found), text };
    }
    return { value: NaN, text };
  };

  const rsiRead = await valueOf(/RSI 14 close\s*([\d.]+)/);
  say(
    Number.isFinite(rsiRead.value) && rsiRead.value >= 0 && rsiRead.value <= 100,
    'RSI computes a value inside 0-100',
    `${rsiRead.value} from "${rsiRead.text}"`,
  );

  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(400);
  await page.fill('.popover .pop-search', 'moving');
  await page.waitForTimeout(400);
  await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Moving average")');
  const maRead = await valueOf(/MA 20 close\s*([\d.]+)/);
  const ma = maRead.value;
  const last = Number(((await page.textContent('.sl-price')) ?? '').replace(/,/g, '').trim());
  say(
    Number.isFinite(ma) && Math.abs(ma - last) / last < 0.05,
    'the moving average sits near the price rather than being nonsense',
    `MA ${ma} vs last ${last}, from "${maRead.text}"`,
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
  const colour = page.locator('.st-row:has-text("Up colour") .cp-text');
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
    (await page.locator('.st-row:has-text("Up colour") .cp-text').inputValue()) === '#8fd0ff',
    'a chart colour survives a reload',
  );
  await page.click('.st-nav-item:text-is("Time and format")');
  await page.waitForTimeout(400);
  say(
    await page.locator('.st-choice-btn:text-is("24-hour")').evaluate((n) => n.classList.contains('st-choice-on')),
    'the clock format survives a reload',
  );

  // Put everything back so the next run starts clean.
  await page.click('.st-choice-btn:text-is("12-hour")');
  await page.click('.st-nav-item:text-is("Canvas")');
  await page.click('.st-actions button:text-is("Reset to defaults")');
  await page.click('.st-danger');
  await page.waitForTimeout(700);
  await page.click('.st-close');
  await page.waitForTimeout(1_000);

  // Read the legend with the dialog CLOSED: the settings dialog covers the
  // chart, and the legend rows are part of the chart.
  const restored = await rowText();
  say(
    /RSI 14/.test(restored) && /MA 20/.test(restored),
    'the indicators survive a reload too',
    restored,
  );

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
