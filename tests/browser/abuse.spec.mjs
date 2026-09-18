/**
 * Atlas, used badly on purpose.
 *
 *   node tests/browser/abuse.spec.mjs
 *
 * Users do not interact perfectly. They double-click, they change their mind
 * mid-load, they hammer a control while a request is still in flight. None of
 * that should be able to crash the terminal, duplicate an object, mix two
 * instruments together or leave a menu stranded on screen.
 *
 * Every section does something a careful test would deliberately avoid, then
 * asks whether the terminal is still coherent. The checks are about STATE, not
 * about whether a click landed: "did the chart end up showing the instrument
 * the ticket is pointed at" is the question.
 */
import { createReport, launch, signIn, clearDrawings, clearIndicators } from './harness.mjs';

const { say, finish, watch } = createReport('abuse');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });
watch(page);

/** No popover, menu or scrim left behind. */
const ghosts = async () =>
  page.evaluate(() => {
    const sel = ['.popover', '.dm-menu', '[data-testid=order-context-menu]', '.dp-scrim', '.st-scrim'];
    const found = [];
    for (const s of sel) {
      const n = document.querySelectorAll(s).length;
      if (n > 0) found.push(s + ' x' + n);
    }
    return found;
  });

/** What the chart says versus what the ticket says. */
const coherence = async () => {
  const chart = (await page.locator('[data-pane=p1] .chdr-symbol').innerText().catch(() => '')).trim();
  const ticket = (await page.locator('[data-testid=ticket-contract], .tk-contract').first().innerText().catch(() => '')).trim();
  return { chart, ticket };
};

const pickSymbol = async (root) => {
  await page.click('[data-pane=p1] .chdr-symbol').catch(() => {});
  await page.waitForTimeout(120);
  await page.click('.popover .pop-item:has(.chdr-pop-root:text-is("' + root + '"))', { timeout: 2500 }).catch(() => {});
};

try {
  await signIn(page);
  await page.waitForTimeout(3000);
  if ((await page.locator('[data-testid=chart-pane]').count()) > 1) {
    await page.click('[data-testid=layout-button]');
    await page.waitForTimeout(350);
    await page.click('[data-testid=layout-choices] button[data-layout=ONE]');
    await page.waitForTimeout(2500);
  }
  await clearDrawings(page);
  await clearIndicators(page);
  await page.waitForTimeout(1000);
  const errorsBefore = errors.length;

  // ===== 1. symbols, faster than the requests can finish ==================
  for (const root of ['ES', 'GC', 'CL', 'NQ', 'ES', 'NQ']) {
    await pickSymbol(root);
    await page.waitForTimeout(120); // deliberately less than a round trip
  }
  await page.waitForTimeout(6000);
  let c = await coherence();
  say(
    c.chart.startsWith('NQ') && c.ticket.includes('NQ'),
    'six symbol changes in under a second settle on the last one',
    'chart ' + c.chart + ' / ticket ' + c.ticket,
  );
  const barsSymbol = await page.evaluate(() => {
    const t = document.querySelector('[data-pane=p1] [data-testid=status-line]');
    return (t ? t.textContent : '').slice(0, 12);
  });
  say(/NQ/.test(barsSymbol), 'and the bars on screen belong to that instrument', barsSymbol);
  let g = await ghosts();
  say(g.length === 0, 'with no menu left open', g.join(' '));

  // ===== 2. timeframes, hammered =========================================
  for (const tf of ['5m', '15m', '1m', '5m', '1m', '15m', '1m']) {
    await page.click('[data-pane=p1] .chdr-tf:has-text("' + tf + '")').catch(() => {});
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(5000);
  const active = await page.locator('.chdr-tf-on').allTextContents();
  say(active.length === 1, 'seven timeframe clicks leave exactly one interval active', active.join(','));
  const line = await page.locator('[data-pane=p1] [data-testid=status-line]').innerText();
  const wanted = (active[0] || 'none').trim();
  say(line.includes(wanted), 'and the status line agrees with the button', wanted + ' vs ' + line.slice(0, 26));

  // ===== 3. layouts, hammered ============================================
  for (const kind of ['TWO_V', 'FOUR', 'ONE', 'THREE', 'ONE']) {
    await page.click('[data-testid=layout-button]').catch(() => {});
    await page.waitForTimeout(100);
    await page.click('[data-testid=layout-choices] button[data-layout=' + kind + ']').catch(() => {});
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(5000);
  const panes = await page.locator('[data-testid=chart-pane]').count();
  say(panes === 1, 'five layout switches in under a second leave one chart', panes + ' panes');
  g = await ghosts();
  say(g.length === 0, 'and no layout menu stranded', g.join(' '));

  // ===== 4. indicators, added and removed as fast as possible ============
  for (let i = 0; i < 5; i += 1) {
    await page.click('.chdr-btn:has-text("Indicators")').catch(() => {});
    await page.waitForTimeout(120);
    await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Exponential moving")').catch(() => {});
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    const rm = page.locator('[data-testid=indicator-row]').first();
    if (await rm.count()) {
      await rm.hover().catch(() => {});
      await rm.locator('.ind-btn-danger').click({ force: true }).catch(() => {});
    }
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(2500);
  const rows = await page.locator('[data-testid=indicator-row]').count();
  say(rows <= 5, 'add/remove hammering does not multiply indicators', rows + ' rows on screen');
  await clearIndicators(page);

  // ===== 5. drawings: create, undo, redo, delete, fast ===================
  const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  for (let i = 0; i < 4; i += 1) {
    await page.click('.rail .rail-btn[aria-label="Trend line"]').catch(() => {});
    await page.mouse.click(at(0.3 + i * 0.05, 0.6).x, at(0.3, 0.6).y);
    await page.mouse.click(at(0.4 + i * 0.05, 0.4).x, at(0.4, 0.4).y);
    await page.waitForTimeout(80);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(1500);
  const drawn = await page.evaluate(() => (window.__atlasDrawings ? window.__atlasDrawings().length : -1));
  const paintedPx = await page.evaluate(() => {
    const c = document.querySelector('.draw-canvas');
    if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 30) lit += 1;
    return lit;
  });
  say(drawn >= 0 && drawn <= 8, 'create/undo/redo hammering leaves a sane object count', drawn + ' objects');
  say(
    (drawn === 0) === (paintedPx === 0),
    'and what is painted agrees with what is stored',
    drawn + ' objects / ' + paintedPx + ' lit pixels',
  );
  await clearDrawings(page);

  // ===== 6. settings and menus, opened and closed repeatedly =============
  for (let i = 0; i < 6; i += 1) {
    await page.click('[data-testid=apprail-settings]').catch(() => {});
    await page.waitForTimeout(90);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1200);
  say((await page.locator('.st-scrim').count()) === 0, 'six settings open/close cycles close cleanly');
  g = await ghosts();
  say(g.length === 0, 'and leave nothing behind', g.join(' '));

  // ===== 7. double clicks and clicks during a load ======================
  await pickSymbol('ES');
  await page.click('[data-pane=p1] .chdr-tf:has-text("5m")').catch(() => {});
  await page.click('[data-pane=p1] .chdr-tf:has-text("5m")').catch(() => {});
  await page.waitForTimeout(6000);
  c = await coherence();
  const active2 = await page.locator('.chdr-tf-on').allTextContents();
  say(
    c.chart.startsWith('ES') && active2.length === 1,
    'a timeframe click during a symbol load leaves both settled',
    c.chart + ' @ ' + active2.join(','),
  );
  await pickSymbol('NQ');
  await page.waitForTimeout(3500);

  // ===== 8. panel resize, hammered ======================================
  const splitter = await page.locator('.splitter-v').boundingBox();
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(splitter.x + 2, splitter.y + splitter.height / 2);
    await page.mouse.down();
    await page.mouse.move(splitter.x + (i % 2 ? -120 : 120), splitter.y + splitter.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1200);
  const right = await page.locator('.terminal-right').boundingBox();
  say(right.width >= 180 && right.width <= 420, 'six fast panel drags leave a usable width', Math.round(right.width) + 'px');
  const spill = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, .num, .abar-box, .chip')) {
      if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) bad.push(el.className);
    }
    return bad.slice(0, 3);
  });
  say(spill.length === 0, 'and nothing spills out of its control', spill.join(' '));

  // ===== 9. account switch while the market is moving ===================
  const options = await page.locator('.abar-account option').evaluateAll((n) => n.map((o) => o.value));
  if (options.length > 1) {
    for (let i = 0; i < 4; i += 1) {
      await page.selectOption('.abar-account', options[i % options.length]).catch(() => {});
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(4000);
    const bal = await page.locator('[data-testid=account-box-bal] .abar-box-value').innerText().catch(() => '');
    say(/\d/.test(bal), 'four fast account switches still show a balance', bal);
    g = await ghosts();
    say(g.length === 0, 'and leave no stale overlay', g.join(' '));
  }

  // ===== 10. the terminal is still the terminal =========================
  const newErrors = errors.slice(errorsBefore);
  say(newErrors.length === 0, 'no console errors through any of it', newErrors.slice(0, 3).join(' | '));
  const alive = await page.evaluate(() => {
    const s = document.querySelector('[data-pane=p1] [data-testid=status-line]');
    return { canvas: document.querySelectorAll('[data-pane=p1] canvas').length, price: s ? s.textContent.length : 0 };
  });
  say(alive.canvas > 0 && alive.price > 10, 'and the chart is still live at the end', JSON.stringify(alive));

} finally {
  await browser.close();
}

process.exit(finish());
