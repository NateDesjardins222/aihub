/**
 * The first five minutes, and the things a new trader cannot ask about.
 *
 * A usability pass cannot be fully automated - whether a label reads well is a
 * judgement - but a surprising amount of what makes a terminal hostile to
 * somebody new IS mechanical, and those parts should never regress:
 *
 *   - a control with no name is a control that cannot be learned, and is
 *     invisible to a screen reader;
 *   - an icon with no tooltip is a guess;
 *   - a raw enum on the screen (TWO_V, FIB_RETRACEMENT) is the inside of the
 *     program leaking out;
 *   - an empty panel that says nothing looks broken rather than empty;
 *   - a destructive button that does not say what it destroys is a trap.
 *
 * What this does NOT claim: that the terminal is easy to learn. That is in the
 * report, written from using it.
 */
import { createReport, launch, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('first-run');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });
watch(page);

/** Buttons with no text, no aria-label and no title: unnameable controls. */
const nameless = (scope) =>
  page.evaluate((selector) => {
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return ['(missing)'];
    const out = [];
    for (const el of root.querySelectorAll('button, [role=button]')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const text = (el.textContent ?? '').trim();
      const label = el.getAttribute('aria-label') ?? '';
      const title = el.getAttribute('title') ?? '';
      if (text.length === 0 && label.length === 0 && title.length === 0) {
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
      }
    }
    return out;
  }, scope);

/** SHOUTING_ENUM text anywhere a trader can read it. */
const leakedEnums = () =>
  page.evaluate(() => {
    const allowed = new Set([
      'NQ', 'ES', 'CL', 'GC', 'MNQ', 'MES', 'MCL', 'MGC', 'RTY', 'YM',
      'BAL', 'MLL', 'RP&L', 'UP&L', 'SIM', 'ACTIVE', 'OPEN', 'CLOSED', 'DELAYED',
      'BUY', 'SELL', 'LONG', 'SHORT', 'MARKET CLOSED', 'MAINTENANCE', 'ORDER',
      'SYMBOL', 'SIDE', 'QTY', 'AVG PRICE', 'CURRENT', 'OPEN P&L', 'REALIZED',
      'FEES', 'STOP', 'TARGET', 'REPLAY', 'REPLAY PAUSED', 'PRE OPEN', 'NO DATA',
      'STALE', 'RAW', 'SMOOTH', 'MACD', 'RSI', 'EMA', 'MA', 'BB', 'ATR', 'VWAP',
    ]);
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent?.trim() ?? '';
          if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(text) && !allowed.has(text)) out.push(text);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const style = getComputedStyle(child);
          if (style.display !== 'none' && style.visibility !== 'hidden') walk(child);
        }
      }
    };
    walk(document.body);
    return [...new Set(out)];
  });

try {
  await signIn(page);
  await page.waitForTimeout(2_500);

  // --- can everything be named? -------------------------------------------
  const railNameless = await nameless('.apprail');
  say(railNameless.length === 0, 'every button on the navigation rail has a name', railNameless.join(' · '));

  const toolNameless = await nameless('.rail');
  say(toolNameless.length === 0, 'and every drawing tool', toolNameless.join(' · '));

  const headerNameless = await nameless('.chdr');
  say(headerNameless.length === 0, 'and every control in the chart header', headerNameless.join(' · '));

  const ticketNameless = await nameless('[data-testid=order-ticket]');
  say(ticketNameless.length === 0, 'and every control in the order ticket', ticketNameless.join(' · '));

  const barNameless = await nameless('.abar');
  say(barNameless.length === 0, 'and every control in the account bar', barNameless.join(' · '));

  // --- does the inside of the program show? --------------------------------
  const leaked = await leakedEnums();
  say(leaked.length === 0, 'no raw enum is shown to the trader', leaked.slice(0, 5).join(' · '));

  // --- do the dangerous buttons say what they do? -------------------------
  const buy = (await page.textContent('[data-testid=buy]')) ?? '';
  const sell = (await page.textContent('[data-testid=sell]')) ?? '';
  say(/\d/.test(buy) && /\d/.test(sell), 'the entry buttons say how much they will trade', `${buy.trim()} / ${sell.trim()}`);

  const close = page.locator('.tk-grid2 button:has-text("Close")');
  say(
    (await close.isDisabled()) || (await close.count()) === 0,
    'and the buttons that close a position are unavailable when there is none',
  );

  // --- does an empty thing explain itself? ---------------------------------
  await page.click('.tab:text-is("Positions")');
  await page.waitForTimeout(800);
  const empty = ((await page.textContent('.panel-body')) ?? '').trim();
  say(empty.length > 4, 'an empty positions panel says it is empty', empty.slice(0, 40));

  await page.click('.tab:text-is("Quotes")');
  await page.waitForTimeout(900);
  const quotes = ((await page.textContent('.panel-body')) ?? '').trim();
  say(quotes.length > 8, 'and an unbuilt panel says so rather than looking broken', quotes.replace(/\s+/g, ' ').slice(0, 60));
  await page.click('.tab:text-is("Positions")');
  await page.waitForTimeout(500);

  // --- can the main things be found from a standing start? ----------------
  const reachable = await page.evaluate(() => {
    const names = [...document.querySelectorAll('.apprail-btn')].map((el) =>
      (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().toLowerCase(),
    );
    return names;
  });
  for (const destination of ['trade', 'practice', 'journal', 'settings']) {
    say(
      reachable.some((name) => name.includes(destination)),
      `${destination} is on the rail without opening anything`,
      reachable.join(', '),
    );
  }

  // --- is anything on the screen a dead end? ------------------------------
  await page.click('.chdr-btn:has-text("Indicators")');
  await page.waitForTimeout(600);
  const catalogue = await page.locator('[data-testid=indicator-catalogue] .pop-item').count();
  say(catalogue >= 8, 'the indicator list offers a real catalogue', `${catalogue} entries`);
  const described = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[data-testid=indicator-catalogue] .pop-item')];
    return items.filter((el) => (el.textContent ?? '').trim().length > 6).length;
  });
  say(described >= catalogue - 2, 'each one named in words rather than in initials', `${described}/${catalogue}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // --- the settings a new trader will open first ---------------------------
  await page.click('[data-testid=apprail-settings]');
  await page.waitForTimeout(900);
  const sections = await page.locator('.st-nav-item').allTextContents();
  say(
    sections.every((name) => /^[A-Z][a-z]/.test(name.trim())),
    'every settings section is titled in words',
    sections.join(', '),
  );
  const rowsWithHints = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.st-content .st-row')];
    return { rows: rows.length, titled: rows.filter((r) => (r.getAttribute('title') ?? '').length > 0).length };
  });
  say(rowsWithHints.rows > 0, 'the first section has settings in it', JSON.stringify(rowsWithHints));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  say(errors.length === 0, 'and nothing on the console while looking around', errors.join(' | ').slice(0, 160));
} finally {
  await browser.close();
}

process.exit(finish());
