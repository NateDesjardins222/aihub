/**
 * Terminal Correction & TradingView Parity V1 — acceptance suite.
 *
 * Every check here drives the REAL application against the real server. It
 * proves the NEW behaviours of the milestone that the older suites do not yet
 * touch:
 *
 *   D-02  symbol search Enter selects the typed instrument, not the old one
 *   D-01  a real draggable divider resizes multi-chart panes, persists, resets
 *   D-03  the synchronised crosshair paints a vertical TIME cursor on the peer
 *   D-04  "apply to other charts" copies config to the other panes
 *   D-11  a right-click on the chart background opens a real context menu
 *   D-10  the Practice section is gone from the app rail (engine preserved)
 *   D-09  Settings opens from the left app rail
 *   K     the dragged split survives a reload (workspace persistence)
 *
 * The drawing tools (Fib D-06, Text D-07, Measure D-05), the study-pane
 * splitter, and the crosshair/range/interval sync bus are exercised by
 * `fib-levels`, `remaining-tools`, `pane-resize` and `multi-chart`; this suite
 * does not duplicate them.
 */
import { createReport, launch, signIn, shot } from './harness.mjs';

const { say, finish, watch } = createReport('tc-v1');
const { browser, page, errors } = await launch({ width: 1680, height: 980 });
watch(page);

async function chooseLayout(kind) {
  await page.click('[data-testid=layout-button]');
  await page.waitForTimeout(400);
  await page.click(`[data-testid=layout-choices] button[data-layout=${kind}]`);
  await page.waitForTimeout(kind === 'ONE' ? 2_500 : 6_000);
}

/** The grid's own column template, so a drag is read from the DOM, not guessed. */
const gridCols = () =>
  page.evaluate(() => {
    const grid = document.querySelector('[data-testid=chart-grid]');
    return grid ? getComputedStyle(grid).gridTemplateColumns : '';
  });

const symbolRoot = (pane) =>
  page
    .locator(`[data-pane=${pane}] .chdr-symbol-root`)
    .first()
    .innerText()
    .then((t) => t.trim().toUpperCase())
    .catch(() => '');

try {
  await signIn(page);
  await page.waitForTimeout(2_000);
  await chooseLayout('ONE');

  // --- D-02 — symbol search Enter selects the TYPED instrument -------------
  // Start somewhere that is not ES, type ES, press Enter, and the chart must
  // become ES. The bug was the substring filter matching "Futures" on every
  // instrument and Enter taking the first row (NQ).
  {
    // Put p1 on GC first via the picker, so the Enter test starts off ES.
    await page.click('[data-pane=p1] .chdr-symbol');
    await page.waitForTimeout(500);
    await page.fill('.popover input.pop-search', 'GC');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    const before = await symbolRoot('p1');

    await page.click('[data-pane=p1] .chdr-symbol');
    await page.waitForTimeout(500);
    await page.fill('.popover input.pop-search', 'ES');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_500);
    const after = await symbolRoot('p1');
    say(
      before === 'GC' && after === 'ES',
      'D-02 typing ES + Enter loads ES (not the old/first symbol)',
      `${before} -> ${after}`,
    );

    // And a substring that is not a root prefix still resolves sensibly: "gold"
    // is GC's description, and Enter on it must land on GC.
    await page.click('[data-pane=p1] .chdr-symbol');
    await page.waitForTimeout(500);
    await page.fill('.popover input.pop-search', 'gold');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    say((await symbolRoot('p1')) === 'GC', 'D-02 a description match ("gold") resolves to GC', await symbolRoot('p1'));

    // Back to NQ for the rest of the suite.
    await page.click('[data-pane=p1] .chdr-symbol');
    await page.waitForTimeout(500);
    await page.fill('.popover input.pop-search', 'NQ');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3_000);
    say((await symbolRoot('p1')) === 'NQ', 'D-02 back to NQ for the following checks', await symbolRoot('p1'));
  }

  // --- D-01 — a real draggable divider resizes side-by-side panes ----------
  await chooseLayout('TWO_V');
  {
    const divider = page.locator('[data-testid=chart-divider-col]');
    say((await divider.count()) === 1, 'D-01 a side-by-side layout has one vertical divider');

    const before = await gridCols();
    const grid = await page.locator('[data-testid=chart-grid]').boundingBox();
    const handle = await divider.boundingBox();
    // Drag the divider well to the left: the left pane must shrink.
    const startX = handle.x + handle.width / 2;
    const y = grid.y + grid.height / 2;
    const targetX = grid.x + grid.width * 0.3;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    const steps = 16;
    for (let i = 1; i <= steps; i += 1) {
      await page.mouse.move(startX + ((targetX - startX) * i) / steps, y);
    }
    await page.mouse.up();
    await page.waitForTimeout(700);
    const after = await gridCols();

    const [lb, rb] = before.split(' ').map((v) => parseFloat(v));
    const [la, ra] = after.split(' ').map((v) => parseFloat(v));
    say(
      Number.isFinite(la) && Number.isFinite(lb) && la < lb - 20,
      'D-01 dragging the divider left shrinks the left pane (continuous, not a preset)',
      `${before} -> ${after}`,
    );
    say(la > 40 && ra > 40, 'D-01 the split is clamped so neither pane collapses', `${Math.round(la)} / ${Math.round(ra)}`);

    // Persistence across a reload (acceptance K).
    await page.waitForTimeout(1_500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
    await page.waitForTimeout(7_000);
    const reloaded = await gridCols();
    const [lr] = reloaded.split(' ').map((v) => parseFloat(v));
    say(
      Number.isFinite(lr) && Math.abs(lr - la) / la < 0.15,
      'K the dragged split survives a reload',
      `${after} -> ${reloaded}`,
    );

    // Double-click resets the division to even.
    const d2 = await page.locator('[data-testid=chart-divider-col]').boundingBox();
    await page.mouse.dblclick(d2.x + d2.width / 2, d2.y + d2.height / 2);
    await page.waitForTimeout(700);
    const reset = await gridCols();
    const [lreset, rreset] = reset.split(' ').map((v) => parseFloat(v));
    say(
      Math.abs(lreset - rreset) / Math.max(lreset, rreset) < 0.05,
      'D-01 double-clicking the divider restores the even split',
      reset,
    );
    await shot(page, 'tc-v1-divider');
  }

  // --- D-03 — synchronised crosshair paints a vertical TIME cursor ---------
  {
    // Turn crosshair sync on through the layout menu.
    await page.click('[data-testid=layout-button]');
    await page.waitForTimeout(400);
    await page.locator('input[aria-label="Sync crosshair"]').check().catch(() => undefined);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
    // Sweep so the pointer lands on a bar with a time to broadcast.
    let cursorVisible = false;
    let peerFollowed = false;
    for (const fx of [0.35, 0.4, 0.45, 0.5]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * 0.5, { steps: 4 });
      await page.waitForTimeout(450);
      // The peer pane (p2) shows a DOM vertical time cursor, not lightweight's
      // own crosshair (which would also move the price axis).
      cursorVisible = await page.evaluate(() => {
        const el = document.querySelector('[data-pane=p2] .lw-time-cursor');
        if (!el) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0;
      });
      const sync = await page.evaluate(() => window.__atlasPaneSync?.() ?? null);
      peerFollowed = !!(sync && typeof sync.crosshair?.p2 === 'number');
      if (cursorVisible && peerFollowed) break;
    }
    say(peerFollowed, 'D-03 the crosshair broadcasts a timestamp the peer pane follows');
    say(cursorVisible, 'D-03 the peer paints a vertical TIME cursor (not a price-moving crosshair)');
    await shot(page, 'tc-v1-crosshair');

    await page.click('[data-testid=layout-button]');
    await page.waitForTimeout(400);
    await page.locator('input[aria-label="Sync crosshair"]').uncheck().catch(() => undefined);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // --- D-04 — apply chart config to the other charts -----------------------
  {
    // Make p1 different: add an indicator, then apply to the others and check
    // p2 receives it. (Symbol/interval are intentionally NOT copied.)
    await page.click('[data-pane=p1] .chdr-btn:has-text("Indicators")');
    await page.waitForTimeout(600);
    await page.click('[data-testid=indicator-catalogue] .pop-item:has-text("Relative strength")');
    await page.waitForTimeout(1_200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const p2Before = await page.locator('[data-pane=p2] [data-testid=indicator-row]').count();
    await page.click('[data-pane=p1] .chdr-icon[title="More"]');
    await page.waitForTimeout(400);
    await page.click('.dm-menu .dm-item:has-text("Apply to other charts"), .pop-item:has-text("Apply to other charts")').catch(async () => {
      await page.click(':text("Apply to other charts")');
    });
    await page.waitForTimeout(1_500);
    const p2After = await page.locator('[data-pane=p2] [data-testid=indicator-row]').count();
    say(
      p2After > p2Before,
      'D-04 "apply to other charts" copies the indicator config to the other pane',
      `p2 rows ${p2Before} -> ${p2After}`,
    );

    // Clean the indicators back off both panes.
    for (const pane of ['p1', 'p2']) {
      const rows = page.locator(`[data-pane=${pane}] [data-testid=indicator-row] .ind-btn-danger`);
      for (let i = 0; i < 6 && (await rows.count()) > 0; i += 1) {
        await rows.first().click().catch(() => undefined);
        await page.waitForTimeout(300);
      }
    }
  }

  // --- D-11 — a right-click on the chart background opens a context menu ----
  await chooseLayout('ONE');
  {
    const box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.5, { button: 'right' });
    await page.waitForTimeout(500);
    const menu = page.locator('[data-testid=chart-context-menu]');
    say((await menu.count()) === 1, 'D-11 right-clicking the chart opens a context menu');
    const items = (await menu.locator('.dm-item').allTextContents()).map((t) => t.trim());
    say(
      items.some((t) => /Reset chart view/i.test(t)) && items.some((t) => /Copy price/i.test(t)),
      'D-11 with real actions (reset view, copy price)',
      items.join(' / '),
    );
    await shot(page, 'tc-v1-context-menu');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // --- D-10 — the Practice section is gone from the app rail ----------------
  {
    const hasPractice = (await page.locator('[data-testid=apprail-practice]').count()) > 0;
    const rails = (await page.locator('.apprail-btn').allTextContents()).map((t) => t.trim());
    say(!hasPractice, 'D-10 the Practice destination is gone from the app rail', rails.join(' / '));
    say(
      rails.some((t) => /Trade/i.test(t)) && rails.some((t) => /Journal/i.test(t)),
      'D-10 and Trade + Journal remain',
      rails.join(' / '),
    );
  }

  // --- D-09 — Settings opens from the left app rail ------------------------
  {
    await page.click('[data-testid=apprail-settings]');
    await page.waitForTimeout(600);
    const open = (await page.locator('.st-nav-item').count()) > 0;
    say(open, 'D-09 Settings opens from the left app rail');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
