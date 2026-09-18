/**
 * The small things, checked the way the big ones are.
 *
 * Two questions the brief asks and neither of which a screenshot answers.
 *
 * MOTION. Every transition in the terminal should be quick enough to feel
 * instant and slow enough to be seen - the brief says 100-200ms - and none of
 * it may be the kind of thing that celebrates: no glow, no bounce, nothing
 * that repeats forever. So this walks every element in every state and reads
 * the durations the browser actually computed, rather than trusting what the
 * stylesheets say.
 *
 * MENUS. Every menu and dialog has to behave the same way, because a surface
 * that closes on Escape and one that does not is a terminal a hand cannot
 * learn. Each one is opened, dismissed with Escape, opened again, dismissed
 * with a click outside, and then the page is checked for what it left behind.
 */
import { createReport, launch, signIn } from './harness.mjs';

const { say, finish, watch } = createReport('polish');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });
watch(page);

/** Every duration the browser computed, and anything that repeats forever. */
const motion = () =>
  page.evaluate(() => {
    const durations = [];
    const forever = [];
    const seconds = (value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (part.endsWith('ms') ? Number.parseFloat(part) : Number.parseFloat(part) * 1000));
    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      const name = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
      for (const ms of [...seconds(style.transitionDuration), ...seconds(style.animationDuration)]) {
        if (ms > 0) durations.push({ name, ms });
      }
      if (style.animationIterationCount.split(',').some((count) => count.trim() === 'infinite')) {
        forever.push(`${name}: ${style.animationName}`);
      }
    }
    return { durations, forever };
  });

/** Popovers, menus and scrims still on the page. */
const ghosts = () =>
  page.evaluate(() =>
    ['.popover', '.dm-menu', '.st-scrim', '.dp-scrim', '[data-testid=colour-popover]']
      .map((selector) => ({ selector, n: document.querySelectorAll(selector).length }))
      .filter((entry) => entry.n > 0)
      .map((entry) => `${entry.selector} x${entry.n}`),
  );

/**
 * One surface, opened and dismissed two ways.
 *
 * `open` does whatever it takes to bring the surface up; `selector` is how the
 * surface is recognised. Escape first, then an outside click, because a menu
 * that only answers one of them is a menu a trader has to think about.
 */
async function surface(name, open, selector, { outsideAt = { x: 840, y: 940 } } = {}) {
  await open();
  await page.waitForTimeout(500);
  const appeared = await page.locator(selector).count();
  say(appeared > 0, `${name} opens`, appeared === 0 ? 'never appeared' : '');
  if (appeared === 0) return;

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  say((await page.locator(selector).count()) === 0, `${name} closes on Escape`);

  await open();
  await page.waitForTimeout(500);
  await page.mouse.click(outsideAt.x, outsideAt.y);
  await page.waitForTimeout(500);
  const left = await page.locator(selector).count();
  say(left === 0, `${name} closes on a click outside`, left > 0 ? `${left} still open` : '');
  if (left > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
}

try {
  await signIn(page);
  await page.waitForTimeout(2_500);

  // --- motion, at rest -----------------------------------------------------
  const resting = await motion();
  const slow = resting.durations.filter((entry) => entry.ms > 260);
  const instant = resting.durations.filter((entry) => entry.ms < 60);
  say(
    slow.length === 0,
    'nothing in the terminal animates for longer than a quarter of a second',
    JSON.stringify(slow.slice(0, 4)),
  );
  say(
    resting.forever.length === 0,
    'and nothing pulses, glows or repeats forever',
    resting.forever.slice(0, 4).join(' · '),
  );
  const range = resting.durations.map((d) => d.ms);
  say(
    range.length > 0,
    'the surfaces that move do move',
    `${range.length} animated properties, ${Math.min(...range)}-${Math.max(...range)}ms`,
  );
  say(
    instant.length <= range.length * 0.2,
    'and almost none of it is too quick to see',
    `${instant.length} under 60ms`,
  );

  // --- two statements a foot apart, one of them false ---------------------
  /*
   * An invariant rather than a snapshot: whatever the session is doing when
   * this runs, the status line may not say the market is closed AND count down
   * to the close of a bar that is not going to close.
   */
  const contradiction = await page.evaluate(() => {
    const line = document.querySelector('[data-pane=p1] [data-testid=status-line]');
    const text = (line?.textContent ?? '').replace(/\s+/g, ' ');
    return { closed: /MARKET CLOSED/.test(text), counting: /closes \d/.test(text), text: text.slice(-60) };
  });
  say(
    !(contradiction.closed && contradiction.counting),
    'the status line does not count down to a bar close while the market is shut',
    contradiction.text,
  );

  // --- the menus -----------------------------------------------------------
  await surface(
    'the symbol search',
    async () => {
      await page.click('.chdr-symbol');
    },
    '.popover',
  );

  await surface(
    'the indicator catalogue',
    async () => {
      await page.click('.chdr-btn:has-text("Indicators")');
    },
    '[data-testid=indicator-catalogue]',
  );

  await surface(
    'the layout menu',
    async () => {
      await page.click('[data-testid=layout-button]');
    },
    '[data-testid=layout-choices]',
  );

  await surface(
    'the settings dialog',
    async () => {
      await page.click('[data-testid=apprail-settings]');
    },
    '.st-dialog',
    { outsideAt: { x: 120, y: 940 } },
  );

  await surface(
    'the chart overflow menu',
    async () => {
      await page.click('.chdr-icon[title="More"]');
    },
    // The overflow uses the shared Popover like every other menu, which is the
    // point: it is recognised by its label rather than by a class of its own.
    '.popover[aria-label="More"]',
  );

  // --- what the menus left behind -----------------------------------------
  const left = await ghosts();
  say(left.length === 0, 'and none of them left anything on the page', left.join(' · '));

  // --- the drawers ---------------------------------------------------------
  await page.click('[data-testid=apprail-journal]');
  await page.waitForSelector('[data-testid=drawer-journal]', { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  const drawerMotion = await motion();
  say(
    drawerMotion.durations.filter((entry) => entry.ms > 260).length === 0,
    'the journal drawer opens without a long animation',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const drawerClosed = (await page.locator('[data-testid=drawer-journal]').count()) === 0;
  say(drawerClosed, 'and Escape closes it like everything else');
  if (!drawerClosed) {
    await page.click('[data-testid=drawer-journal] .drawer-close').catch(() => {});
    await page.waitForTimeout(600);
  }

  // --- focus is not thrown away -------------------------------------------
  /*
   * A dialog that closes and leaves focus on a node it removed leaves the
   * keyboard pointing at nothing: the next Tab starts from the top of the
   * document and the next Escape goes nowhere.
   */
  await page.click('[data-testid=apprail-settings]');
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName.toLowerCase() ?? 'none',
      attached: active ? document.body.contains(active) : false,
    };
  });
  say(focus.attached, 'closing a dialog leaves focus on something that exists', JSON.stringify(focus));

  say(errors.length === 0, 'no page errors', errors.join(' | ').slice(0, 200));
} finally {
  await browser.close();
}

process.exit(finish());
