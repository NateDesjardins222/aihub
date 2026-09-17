/**
 * Nothing may spill out of its own control, at any panel size.
 *
 * The brief is absolute about this: "text/numbers cannot spill outside
 * controls, controls cannot overlap, labels cannot become unreadable, buttons
 * cannot stack on top of each other" - and it was reported from the actual
 * application, where narrowing the order panel pushed the quantity numbers out
 * of their buttons.
 *
 * So this does not check a list of places. It walks every visible element in
 * the terminal and asks the browser two questions:
 *
 *   is your content wider than your box?
 *   do you overlap a sibling you are not supposed to?
 *
 * Then it drags every resizable panel from maximum to minimum to maximum and
 * asks again, at several window sizes. A failure names the element, so it can
 * be fixed rather than hunted.
 */
import { createReport, launch, shot, signIn } from './harness.mjs';

const { say, finish } = createReport('responsive');
const { browser, page, errors } = await launch({ width: 1680, height: 1000 });

/**
 * Every element whose text does not fit, or which overlaps a sibling.
 *
 * Scrollable regions are exempt from the overflow test: a table or a list is
 * ALLOWED to be wider than its viewport, that is what scrolling is for. What
 * is not allowed is a button, a label or a metric whose own text is bigger
 * than the box drawn around it.
 */
async function faults() {
  return page.evaluate(() => {
    const out = [];
    const describe = (el) => {
      const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };

    const scrollable = (el) => {
      const style = getComputedStyle(el);
      return (
        /auto|scroll/.test(style.overflowX) ||
        /auto|scroll/.test(style.overflowY) ||
        el.closest('table') !== null ||
        el.closest('[data-scrolls]') !== null
      );
    };

    const controls = [];
    for (const el of document.querySelectorAll(
      'button, .label, .chip, .num, .abar-metric, .tk-label, select, input, .pill, .metric',
    )) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      controls.push({ el, rect });

      // 1. Content bigger than its own box, where clipping is not intended.
      if (!scrollable(el) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        out.push({
          kind: 'text does not fit',
          el: describe(el),
          detail: `${el.scrollWidth}px of content in a ${el.clientWidth}px box`,
          text: (el.textContent ?? '').trim().slice(0, 28),
        });
      }
    }

    // 2. Overlapping SIBLINGS. Only siblings: a label inside a button
    // legitimately sits on top of it, and an absolutely positioned overlay is
    // meant to.
    for (let i = 0; i < controls.length; i += 1) {
      const a = controls[i];
      if (getComputedStyle(a.el).position !== 'static') continue;
      for (let j = i + 1; j < controls.length; j += 1) {
        const b = controls[j];
        if (a.el.parentElement !== b.el.parentElement) continue;
        if (getComputedStyle(b.el).position !== 'static') continue;
        const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (overlapX > 1 && overlapY > 1) {
          out.push({
            kind: 'controls overlap',
            el: `${describe(a.el)} / ${describe(b.el)}`,
            detail: `${Math.round(overlapX)}x${Math.round(overlapY)}px`,
            text: `${(a.el.textContent ?? '').trim().slice(0, 12)} | ${(b.el.textContent ?? '').trim().slice(0, 12)}`,
          });
        }
      }
    }
    return out;
  });
}

/** Drag a splitter by a number of pixels along its axis. */
async function drag(selector, dx, dy) {
  const box = await page.locator(selector).boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  return true;
}

const report = async (label) => {
  const found = await faults();
  say(
    found.length === 0,
    label,
    found
      .slice(0, 4)
      .map((f) => `${f.kind}: ${f.el} (${f.detail}) "${f.text}"`)
      .join(' · '),
  );
  return found;
};

try {
  await signIn(page);
  await page.waitForTimeout(3000);

  await report('nothing spills or overlaps at 1680x1000');

  // --- the order panel, maximum to minimum to maximum ----------------------
  await drag('.splitter-v', -400, 0);
  const wide = await page.locator('.terminal-right').boundingBox();
  await report(`the order panel at its widest (${Math.round(wide.width)}px)`);

  await drag('.splitter-v', 600, 0);
  const narrow = await page.locator('.terminal-right').boundingBox();
  await report(`the order panel at its narrowest (${Math.round(narrow.width)}px)`);
  await shot(page, 'responsive-order-narrow');
  say(
    narrow.width >= 160,
    'and it stops at a width its controls still fit in',
    `${Math.round(narrow.width)}px`,
  );

  await drag('.splitter-v', -300, 0);
  await report('and back again');

  // --- the bottom panel ----------------------------------------------------
  await drag('.splitter-h', 0, -400);
  const tall = await page.locator('.terminal-bottom').boundingBox();
  await report(`the bottom panel at its tallest (${Math.round(tall.height)}px)`);

  await drag('.splitter-h', 0, 600);
  const short = await page.locator('.terminal-bottom').boundingBox();
  await report(`the bottom panel at its shortest (${Math.round(short.height)}px)`);

  await drag('.splitter-h', 0, -200);
  await report('and back again');

  // --- window sizes a trader actually uses ---------------------------------
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1600, height: 900 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(1_200);
    await report(`nothing spills or overlaps at ${size.width}x${size.height}`);
  }

  // --- and at the narrowest window with the narrowest panels ---------------
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(800);
  await drag('.splitter-v', 600, 0);
  await drag('.splitter-h', 0, 600);
  await report('nothing spills at 1280x720 with every panel at its minimum');
  await shot(page, 'responsive-1280-minimum');

  // Put it back, so the next suite starts from a sane workspace.
  await drag('.splitter-v', -120, 0);
  await drag('.splitter-h', 0, -140);

  say(errors.length === 0, 'no page errors', errors.join(' | '));
} finally {
  await browser.close();
}

process.exit(finish());
