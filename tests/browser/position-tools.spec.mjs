/**
 * The Long and Short position tools.
 *
 * The brief: "Long Position / Short Position drawing tools with target, entry
 * and stop, risk-reward, quantity / account risk, independently draggable -
 * and they must NEVER submit an order."
 *
 * So this suite does two jobs. It checks the tool plans a trade correctly, and
 * it checks the terminal's real trading state is completely untouched by it:
 * no position, no order, no change in balance. A drawing that can move money
 * is not a drawing.
 */
import { clearDrawings, createReport, launch, litPixels, shot, signIn, useSymbol } from './harness.mjs';

const { say, finish, watch } = createReport('position-tools');
const { browser, page, errors } = await launch({ width: 1600, height: 950 });
watch(page);

/** Arm a tool from the rail's full catalogue. */
async function pick(name) {
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(400);
  if ((await page.locator(`.popover .rail-tool-item:has-text("${name}")`).count()) === 0) {
    await page.click('.popover .pop-item:has-text("Projection")');
    await page.waitForTimeout(300);
  }
  await page.click(`.popover .rail-tool-item:has-text("${name}")`);
  await page.waitForTimeout(400);
}

/** The object tree's own description of every object, which carries the prices. */
async function treeRows() {
  const open = await page.locator('[data-testid=object-tree]').count();
  if (!open) {
    await page.click('.rail .rail-btn[aria-label="Object tree"]');
    await page.waitForTimeout(400);
  }
  const rows = await page.locator('[data-testid=object-tree-row] .ot-detail').allTextContents();
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(250);
  return rows.map((row) => row.replace(/\s+/g, ' ').trim());
}

/** The three prices of a position object, read from the object tree. */
function prices(row) {
  const match = /^([\d,.]+) T ([\d,.]+) S ([\d,.]+)$/.exec(row);
  if (!match) return null;
  const n = (text) => Number(text.replace(/,/g, ''));
  return { entry: n(match[1]), target: n(match[2]), stop: n(match[3]) };
}

/** Open the selected object's settings and read its risk line. */
async function openSettings() {
  await page.click('.rail .rail-btn[aria-label="Object tree"]');
  await page.waitForTimeout(400);
  await page.locator('[data-testid=object-tree-row] .ot-name').first().dblclick();
  await page.waitForTimeout(600);
}

async function riskLine() {
  return (await page.locator('[data-testid=drawing-properties] .st-note').first().innerText())
    .replace(/\s+/g, ' ')
    .trim();
}

async function setNumber(label, value) {
  const input = page
    .locator(`[data-testid=drawing-properties] .st-row:has(.st-row-label:text-is("${label}")) input[type=number]`)
    .first();
  await input.fill(String(value));
  await input.dispatchEvent('change');
  await page.waitForTimeout(400);
}

async function closeSettings() {
  await page.click('[data-testid=drawing-properties] button[aria-label="Close object settings"]');
  await page.waitForTimeout(400);
}

try {
  await signIn(page);
  // This suite trades NQ, so the ticket has to be pointed at NQ.
  await useSymbol(page, 'NQ');
  await page.waitForTimeout(4_000);
  await clearDrawings(page);

  const canvas = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: canvas.x + canvas.width * fx, y: canvas.y + canvas.height * fy });

  // What the account looks like BEFORE any of this. Nothing below may change it.
  const readAccount = async () =>
    (await page.locator('.abar').innerText()).replace(/\s+/g, ' ').replace(/\d+:\d+:\d+ ?[AP]?M?/g, '');
  const accountBefore = await readAccount();
  const orderRows = async () => {
    await page.click('.tab:has-text("Orders")');
    await page.waitForTimeout(700);
    const count = await page.locator('.panel-body tbody tr').count();
    await page.click('.tab:has-text("Positions")');
    await page.waitForTimeout(400);
    return count;
  };
  const ordersBefore = await orderRows();

  // --- the tool exists and is findable ------------------------------------
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(400);
  const categories = await page.locator('.popover .pop-item').allTextContents();
  say(
    categories.some((text) => /Projection/.test(text)),
    'the rail catalogue has a Projection category (long/short)',
    categories.map((c) => c.replace(/\s+/g, ' ').trim()).join(' / '),
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- one click places a whole trade -------------------------------------
  await pick('Long position');
  const entryPoint = at(0.32, 0.45);
  await page.mouse.click(entryPoint.x, entryPoint.y);
  await page.waitForTimeout(800);
  say((await litPixels(page)) > 400, 'one click places a long position', `${await litPixels(page)} lit pixels`);

  let rows = await treeRows();
  const long = prices(rows[0] ?? '');
  say(
    long !== null && long.target > long.entry && long.stop < long.entry,
    'with the target above the entry and the stop below it',
    rows[0] ?? '(no row)',
  );
  // The default box is now sized to the visible range (not a fixed 20/40
  // ticks), so what is invariant is the 2:1 SHAPE: the target is twice as far
  // from the entry as the stop.
  const rewardDist = long ? Math.abs(long.target - long.entry) : 0;
  const riskDist = long ? Math.abs(long.entry - long.stop) : 0;
  say(
    long !== null && riskDist > 0 && Math.abs(rewardDist / riskDist - 2) < 0.06,
    'at a 2:1 default, scale-aware (reward twice the risk)',
    long ? `reward ${rewardDist.toFixed(2)} / risk ${riskDist.toFixed(2)} = ${(rewardDist / riskDist).toFixed(2)}` : '',
  );

  // --- what it says the trade is worth ------------------------------------
  await openSettings();
  const labels = await page.locator('[data-testid=drawing-properties] .st-row-label').allTextContents();
  for (const wanted of ['Entry', 'Target', 'Stop', 'Contracts', 'Account size']) {
    say(labels.includes(wanted), `the settings expose ${wanted.toLowerCase()}`);
  }

  const one = await riskLine();
  // Parse the ticks/dollars rather than asserting the old fixed 20/40 numbers,
  // since the box is scale-aware now. The relationships are the invariant:
  // reward ticks = 2 x risk ticks, R:R 2.0, and dollars = ticks x $5 (NQ) x qty.
  const parseLine = (s) => {
    const m = s.match(/Risk (\d+) ticks · reward (\d+) ticks · R:R ([\d.]+)[^$]*risk \$([\d,]+), reward \$([\d,]+)/);
    if (!m) return null;
    return {
      riskTicks: Number(m[1]),
      rewardTicks: Number(m[2]),
      rr: Number(m[3]),
      riskUsd: Number(m[4].replace(/,/g, '')),
      rewardUsd: Number(m[5].replace(/,/g, '')),
    };
  };
  const p1 = parseLine(one);
  say(
    p1 !== null && p1.rewardTicks === p1.riskTicks * 2 && Math.abs(p1.rr - 2) < 0.05,
    'the risk and the reward are stated in ticks with a 2:1 ratio',
    one,
  );
  say(
    p1 !== null && p1.riskUsd === p1.riskTicks * 5 && p1.rewardUsd === p1.riskUsd * 2,
    'and in dollars for one NQ contract ($5/tick)',
    one,
  );
  say(/never places an order/.test(one), 'and it says out loud that it places nothing');

  // Three contracts: the money triples, the ticks do not move.
  await setNumber('Contracts', 3);
  const three = await riskLine();
  const p3 = parseLine(three);
  say(
    p3 !== null && p1 !== null && p3.riskTicks === p1.riskTicks && p3.riskUsd === p1.riskUsd * 3,
    'the contract count prices the same trade (money triples, ticks do not)',
    three,
  );

  // An account size turns the risk into a percentage.
  await setNumber('Account size', 50_000);
  const pct = await riskLine();
  say(/% of the account/.test(pct), 'and an account size turns it into account risk', pct);

  // --- typed coordinates ---------------------------------------------------
  const entryValue = await page
    .locator('[data-testid=drawing-properties] .st-row:has(.st-row-label:text-is("Entry")) input[type=number]')
    .first()
    .inputValue();
  /*
   * A stop far enough below the entry to be a separate HANDLE.
   *
   * Measured as a share of the visible price range rather than as a number of
   * points: a previous suite can leave the chart zoomed out to thirteen
   * hundred points, where ten points is five pixels and the entry and stop
   * handles are the same handle. This is the drag test, so the thing being
   * dragged has to be reachable.
   */
  const view0 = await page.evaluate(() => window.__atlasChartView?.() ?? null);
  const drop = Math.max(10, Math.round(((view0?.priceRange ?? 60) * 0.15) / 0.25) * 0.25);
  await setNumber('Stop', Number(entryValue) - drop);
  const typed = await riskLine();
  const wantTicks = Math.round(drop / 0.25);
  say(
    new RegExp(`Risk ${wantTicks} ticks`).test(typed),
    'a stop can be typed instead of dragged',
    `asked for ${drop} points below the entry: ${typed}`,
  );
  await closeSettings();

  rows = await treeRows();
  const afterTyping = prices(rows[0] ?? '');
  say(
    afterTyping !== null &&
      Math.abs(afterTyping.entry - Number(entryValue)) < 0.01 &&
      Math.abs(afterTyping.stop - (Number(entryValue) - drop)) < 0.01,
    'and only the stop moved',
    `${rows[0] ?? ''} against a typed ${Number(entryValue) - drop}`,
  );

  // --- dragging one level, not the others ---------------------------------
  /*
   * The stop, and only the stop.
   *
   * Its handle sits at the middle of the box, at the stop's own price. The box
   * is thirty bars wide, so the middle is fifteen bars to the right of the
   * entry - read from the chart's own bar spacing rather than guessed at.
   */
  await page.mouse.click(entryPoint.x + 30, entryPoint.y + 4);
  await page.waitForTimeout(500);
  const selected = (await page.locator('[data-testid=drawing-style-bar]:not([hidden])').count()) === 1;
  say(selected, 'clicking inside the box selects it');

  const before = prices((await treeRows())[0] ?? '');
  const view = await page.evaluate((price) => window.__atlasChartView?.(undefined, price) ?? null, before.stop);
  say(view !== null && view.yAtPrice !== null, 'the chart can say where the stop is painted');

  const midX = entryPoint.x + (view.barSpacing * 30) / 2;
  const stopPageY = canvas.y + view.yAtPrice;
  await page.mouse.move(midX, stopPageY);
  await page.waitForTimeout(300);
  // The cursor is the terminal telling the trader what the press will do.
  say(
    (await page.locator('.chart-canvas').evaluate((n) => n.style.cursor)) === 'ns-resize',
    'the stop handle offers a resize cursor before it is grabbed',
  );
  await page.mouse.down();
  await page.mouse.move(midX, stopPageY + 45, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(700);

  const dragged = prices((await treeRows())[0] ?? '');
  say(
    dragged !== null && dragged.stop < before.stop,
    'dragging the stop handle moves the stop down',
    `${before.stop} -> ${dragged?.stop}`,
  );
  say(
    dragged !== null && dragged.entry === before.entry && dragged.target === before.target,
    'and leaves the entry and the target exactly where they were',
    `entry ${before.entry} -> ${dragged?.entry}, target ${before.target} -> ${dragged?.target}`,
  );

  // A body drag moves the whole trade, all three prices together.
  await page.mouse.move(midX, canvas.y + view.yAtPrice - 20);
  await page.mouse.down();
  await page.mouse.move(midX + 20, canvas.y + view.yAtPrice - 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const moved = prices((await treeRows())[0] ?? '');
  say(
    moved !== null &&
      moved.entry > dragged.entry &&
      moved.target > dragged.target &&
      moved.stop > dragged.stop,
    'dragging the body moves the whole trade',
    `${dragged.entry}/${dragged.target}/${dragged.stop} -> ${moved?.entry}/${moved?.target}/${moved?.stop}`,
  );
  say(
    moved !== null &&
      Math.abs(moved.target - moved.entry - (dragged.target - dragged.entry)) < 0.5 &&
      Math.abs(moved.entry - moved.stop - (dragged.entry - dragged.stop)) < 0.5,
    'without changing the trade it describes',
    moved
      ? `reward ${(moved.target - moved.entry).toFixed(2)}, risk ${(moved.entry - moved.stop).toFixed(2)}`
      : '',
  );

  await shot(page, 'position-long');

  // --- the short is the mirror --------------------------------------------
  await pick('Short position');
  const shortPoint = at(0.62, 0.35);
  await page.mouse.click(shortPoint.x, shortPoint.y);
  await page.waitForTimeout(800);
  rows = await treeRows();
  const short = prices(rows[0] ?? '');
  say(
    short !== null && short.target < short.entry && short.stop > short.entry,
    'a short position puts the target below the entry and the stop above it',
    rows[0] ?? '',
  );
  say(rows.length === 2, 'both objects are on the chart at once', rows.join(' | '));
  await shot(page, 'position-both');

  // --- THE POINT: nothing was traded --------------------------------------
  const positions = (await page.locator('.panel-body').innerText()).replace(/\s+/g, ' ');
  say(
    /No open positions/i.test(positions),
    'no position was opened by drawing a position',
    positions.slice(0, 80),
  );

  const ordersAfter = await orderRows();
  say(
    ordersAfter === ordersBefore,
    'and not one order was placed',
    `${ordersBefore} order rows before, ${ordersAfter} after`,
  );

  const accountAfter = await readAccount();
  say(
    accountAfter === accountBefore,
    'and the account is exactly as it was',
    accountAfter === accountBefore ? accountAfter.slice(0, 70) : `${accountBefore} -> ${accountAfter}`,
  );

  // --- persistence ---------------------------------------------------------
  await page.waitForTimeout(6_000);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chart-canvas canvas', { timeout: 40_000 });
  await page.waitForTimeout(6_000);
  const reloaded = await treeRows();
  say(
    reloaded.length === 2 && prices(reloaded[0] ?? '') !== null,
    'both survive a reload with their three prices',
    reloaded.join(' | '),
  );

  await clearDrawings(page);
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
