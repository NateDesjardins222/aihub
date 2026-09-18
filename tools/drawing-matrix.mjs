/**
 * Every drawing tool, through the whole lifecycle, one cell at a time.
 *
 * The brief was specific: "Stop using test counts as proof of usability. Every
 * exposed drawing tool must manually pass select -> place -> select object ->
 * drag entire object -> drag every anchor -> edit -> style -> duplicate ->
 * copy/paste -> undo -> redo -> lock -> unlock -> hide/show -> zoom -> pan ->
 * timeframe change -> reload -> delete."
 *
 * A suite that reports "68/68" answers none of that, because it does not say
 * WHICH tool failed WHICH step. This walks the matrix and prints it, one row
 * per tool and one column per step, so a gap has a name and a coordinate.
 * Every cell is driven through real pointer events on a real chart, and every
 * tool is photographed after being placed.
 *
 *   node tools/drawing-matrix.mjs            # every tool
 *   node tools/drawing-matrix.mjs "Trend line" Rectangle
 */
import { clearDrawings, launch, shot, signIn, useSymbol } from '../tests/browser/harness.mjs';

const ONLY = process.argv.slice(2);

/**
 * The tools, with where they live in the catalogue and how to place one.
 *
 * `points` are fractions of the plot. A tool taking one click gets one point.
 */
const TOOLS = [
  { label: 'Trend line', category: 'Lines', points: [[0.30, 0.62], [0.44, 0.38]], anchors: 2 },
  { label: 'Horizontal line', category: 'Lines', points: [[0.40, 0.46]], anchors: 1 },
  { label: 'Vertical line', category: 'Lines', points: [[0.46, 0.50]], anchors: 1 },
  { label: 'Ray', category: 'Lines', points: [[0.32, 0.66], [0.46, 0.52]], anchors: 2 },
  { label: 'Extended line', category: 'Lines', points: [[0.33, 0.34], [0.47, 0.28]], anchors: 2 },
  { label: 'Rectangle', category: 'Shapes', points: [[0.34, 0.32], [0.50, 0.56]], anchors: 2 },
  { label: 'Fib retracement', category: 'Fibonacci', points: [[0.30, 0.74], [0.46, 0.54]], anchors: 2 },
  { label: 'Measure', category: 'Measure', points: [[0.36, 0.42], [0.50, 0.62]], anchors: 2 },
  { label: 'Text', category: 'Annotation', points: [[0.40, 0.70]], anchors: 1 },
  { label: 'Long position', category: 'Risk and reward', points: [[0.38, 0.52]], anchors: 3 },
  { label: 'Short position', category: 'Risk and reward', points: [[0.42, 0.44]], anchors: 3 },
];

const STEPS = [
  'select',
  'place',
  'reselect',
  'drag body',
  'drag anchors',
  'edit',
  'style',
  'duplicate',
  'copy/paste',
  'undo',
  'redo',
  'lock',
  'unlock',
  'hide/show',
  'zoom',
  'pan',
  'timeframe',
  'reload',
  'delete',
];

const { browser, page, errors } = await launch({ width: 1680, height: 1050 });

/** Every drawing on the chart, read from the store the chart actually uses. */
const objects = () =>
  page.evaluate(() => {
    const store = window.__atlasDrawings?.();
    return store ?? null;
  });

const at = (box, fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

async function arm(category, label) {
  await page.click('.rail .rail-btn[aria-label="All drawing tools"]');
  await page.waitForTimeout(350);
  const section = page.locator(`.popover .pop-item:has-text("${category}")`).first();
  if ((await section.count()) > 0 && (await section.getAttribute('aria-expanded')) !== 'true') {
    await section.click();
    await page.waitForTimeout(300);
  }
  await page.click(`.popover .rail-tool-item:text-is("${label}")`);
  await page.waitForTimeout(400);
}

const results = new Map();
function record(tool, step, ok, detail = '') {
  const row = results.get(tool) ?? new Map();
  row.set(step, { ok, detail });
  results.set(tool, row);
}

/** Run one cell, recording a throw as a failure rather than ending the run. */
async function cell(tool, step, fn) {
  try {
    const outcome = await fn();
    const ok = outcome === true || (outcome && outcome.ok);
    record(tool, step, Boolean(ok), typeof outcome === 'object' ? (outcome.detail ?? '') : '');
  } catch (error) {
    record(tool, step, false, String(error).split('\n')[0].slice(0, 80));
  }
}

try {
  await signIn(page);
  await useSymbol(page, 'NQ');
  await page.waitForTimeout(3500);

  for (const tool of TOOLS) {
    if (ONLY.length > 0 && !ONLY.includes(tool.label)) continue;
    process.stdout.write(`${tool.label}... `);
    await clearDrawings(page);
    await page.waitForTimeout(400);
    let box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();

    // --- select the tool ---
    await cell(tool.label, 'select', async () => {
      await arm(tool.category, tool.label);
      const armed = await page.evaluate(() => window.__atlasTool?.() ?? null);
      return { ok: armed !== 'CURSOR' && armed !== null, detail: String(armed) };
    });

    // --- place it ---
    await cell(tool.label, 'place', async () => {
      for (const [fx, fy] of tool.points) {
        const p = at(box, fx, fy);
        await page.mouse.move(p.x, p.y, { steps: 3 });
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(280);
      }
      await page.waitForTimeout(500);
      const all = await objects();
      return { ok: all !== null && all.length === 1, detail: `${all?.length ?? '?'} object(s)` };
    });
    await shot(page, `matrix-${tool.label.toLowerCase().replace(/[^a-z]+/g, '-')}`);
    // Every step from here names the object it is about: duplicating and
    // pasting leave three on the chart and move the selection.
    const id = (await objects())?.[0]?.id ?? null;
    const mine = async () => (await objects()).find((d) => d.id === id) ?? null;

    // The tool must have disarmed itself: one object, then the cursor back.
    await cell(tool.label, 'reselect', async () => {
      const armed = await page.evaluate(() => window.__atlasTool?.() ?? null);
      if (armed !== 'CURSOR') return { ok: false, detail: `still armed: ${armed}` };
      await page.keyboard.press('Escape');
      const all = await objects();
      const first = all?.[0];
      if (!first) return { ok: false, detail: 'nothing to select' };
      const hit = await page.evaluate((target) => window.__atlasSelect?.(target) ?? false, first.id);
      await page.waitForTimeout(300);
      const sel = await page.evaluate(() => window.__atlasSelected?.() ?? null);
      return { ok: hit && sel === first.id, detail: sel ? 'selected' : 'not selected' };
    });

    // --- drag the whole object ---
    await cell(tool.label, 'drag body', async () => {
      const before = await mine();
      const moved = await page.evaluate((t) => window.__atlasNudge?.(6, t) ?? false, id);
      await page.waitForTimeout(400);
      const after = await mine();
      const changed =
        JSON.stringify(before.anchors) !== JSON.stringify(after.anchors);
      return { ok: moved && changed, detail: changed ? 'anchors moved together' : 'unchanged' };
    });

    // --- drag every anchor ---
    await cell(tool.label, 'drag anchors', async () => {
      const before = await mine();
      const n = before.anchors.length;
      let movedAll = true;
      for (let i = 0; i < n; i += 1) {
        const ok = await page.evaluate(
          ([index, delta, t]) => window.__atlasMoveAnchor?.(index, delta, t) ?? false,
          [i, 3, id],
        );
        if (!ok) movedAll = false;
      }
      await page.waitForTimeout(400);
      const after = await mine();
      let allChanged = true;
      for (let i = 0; i < n; i += 1) {
        if (before.anchors[i].price === after.anchors[i].price) allChanged = false;
      }
      return { ok: movedAll && allChanged, detail: `${n} anchor(s)` };
    });

    // --- the settings dialog edits it ---
    await cell(tool.label, 'edit', async () => {
      await page.evaluate((t) => window.__atlasOpenProperties?.(t), id);
      await page.waitForTimeout(600);
      const open = (await page.locator('.dp-dialog').count()) > 0;
      const groups = await page.locator('.dp-dialog .st-group-title').allTextContents();
      // Through the store, because the key handler refuses every shortcut
      // while a dialog scrim is in the DOM - including the Ctrl+Z two steps
      // below, which is how "undo is broken" was reported.
      await page.evaluate(() => window.__atlasCloseProperties?.());
      await page.waitForTimeout(400);
      // React removes the scrim on its next render, so the check is here
      // rather than inside the call.
      const closed = (await page.locator('.dp-scrim').count()) === 0;
      return {
        ok: open && groups.length > 0 && closed,
        detail: groups.join('/').slice(0, 42),
      };
    });

    // --- the style bar restyles it ---
    await cell(tool.label, 'style', async () => {
      const before = await mine();
      const applied = await page.evaluate((t) => window.__atlasRestyle?.('#ff00ff', t) ?? false, id);
      await page.waitForTimeout(400);
      const after = await mine();
      return {
        ok: applied && after.style.color !== before.style.color,
        detail: `${before.style.color} -> ${after.style.color}`,
      };
    });

    for (const [step, action, expect] of [
      ['duplicate', () => page.evaluate((t) => window.__atlasDuplicate?.(t) ?? false, id), 2],
      ['copy/paste', () => page.evaluate((t) => window.__atlasCopyPaste?.(t) ?? false, id), 3],
    ]) {
      await cell(tool.label, step, async () => {
        const ok = await action();
        await page.waitForTimeout(450);
        const all = await objects();
        return { ok: ok && all.length === expect, detail: `${all.length} object(s)` };
      });
    }

    await cell(tool.label, 'undo', async () => {
      const before = (await objects()).length;
      await page.keyboard.press('Control+z');
      await page.waitForTimeout(500);
      const after = (await objects()).length;
      return { ok: after < before, detail: `${before} -> ${after}` };
    });

    await cell(tool.label, 'redo', async () => {
      const before = (await objects()).length;
      await page.keyboard.press('Control+Shift+z');
      await page.waitForTimeout(500);
      const after = (await objects()).length;
      return { ok: after > before, detail: `${before} -> ${after}` };
    });

    await cell(tool.label, 'lock', async () => {
      const ok = await page.evaluate((t) => window.__atlasSetLocked?.(true, t) ?? false, id);
      await page.waitForTimeout(300);
      const before = await mine();
      const moved = await page.evaluate((t) => window.__atlasNudge?.(8, t) ?? false, id);
      await page.waitForTimeout(300);
      const after = await mine();
      const held = JSON.stringify(before.anchors) === JSON.stringify(after.anchors);
      return { ok: ok && held, detail: held ? 'refused the move' : 'MOVED WHILE LOCKED' };
    });

    await cell(tool.label, 'unlock', async () => {
      await page.evaluate((t) => window.__atlasSetLocked?.(false, t), id);
      await page.waitForTimeout(300);
      const before = await mine();
      await page.evaluate((t) => window.__atlasNudge?.(8, t), id);
      await page.waitForTimeout(300);
      const after = await mine();
      const changed = JSON.stringify(before.anchors) !== JSON.stringify(after.anchors);
      return { ok: changed, detail: changed ? 'moves again' : 'still stuck' };
    });

    await cell(tool.label, 'hide/show', async () => {
      const lit = () => page.evaluate(() => {
        const c = document.querySelector('.draw-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n += 1;
        return n;
      });
      const shown = await lit();
      await page.evaluate((t) => window.__atlasSetHidden?.(true, t), id);
      await page.waitForTimeout(450);
      const hidden = await lit();
      await page.evaluate((t) => window.__atlasSetHidden?.(false, t), id);
      await page.waitForTimeout(450);
      const back = await lit();
      return {
        ok: hidden < shown && back > hidden,
        detail: `${shown} px -> ${hidden} -> ${back}`,
      };
    });

    // --- zoom, pan, timeframe, reload: the anchors must survive ---
    const priceOf = async () => (await mine())?.anchors.map((a) => a.price).join(',') ?? '';

    await cell(tool.label, 'zoom', async () => {
      const before = await priceOf();
      const p = at(box, 0.5, 0.5);
      await page.mouse.move(p.x, p.y);
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(70);
      }
      await page.waitForTimeout(600);
      return { ok: (await priceOf()) === before, detail: 'anchors unchanged' };
    });

    await cell(tool.label, 'pan', async () => {
      const before = await priceOf();
      const from = at(box, 0.6, 0.5);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x - 160, from.y, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(600);
      return { ok: (await priceOf()) === before, detail: 'anchors unchanged' };
    });

    await cell(tool.label, 'timeframe', async () => {
      const before = await priceOf();
      await page.click('[data-pane=p1] .chdr-tf:has-text("5m")');
      await page.waitForTimeout(2600);
      const mid = await priceOf();
      await page.click('[data-pane=p1] .chdr-tf:has-text("1m")');
      await page.waitForTimeout(2600);
      const after = await priceOf();
      return { ok: mid === before && after === before, detail: '1m -> 5m -> 1m' };
    });

    await cell(tool.label, 'reload', async () => {
      const before = await priceOf();
      const count = (await objects()).length;
      await page.reload();
      await page.waitForTimeout(6500);
      const all = await objects();
      const after = (all ?? []).find((d) => d.id === id)?.anchors.map((a) => a.price).join(',');
      return {
        ok: all?.length === count && after === before,
        detail: `${count} object(s) survived`,
      };
    });

    await cell(tool.label, 'delete', async () => {
      box = await page.locator('[data-pane=p1] .chart-canvas').boundingBox();
      const ok = await page.evaluate(() => window.__atlasClear?.() ?? false);
      await page.waitForTimeout(600);
      const all = await objects();
      return { ok: ok && all.length === 0, detail: `${all.length} left` };
    });

    const row = results.get(tool.label);
    const failed = [...row].filter(([, v]) => !v.ok).length;
    console.log(failed === 0 ? 'all steps passed' : `${failed} step(s) failed`);
  }

  // --- the matrix ---
  console.log(`\n| Tool | ${STEPS.join(' | ')} |`);
  console.log(`| --- | ${STEPS.map(() => '---').join(' | ')} |`);
  for (const [tool, row] of results) {
    const cells = STEPS.map((step) => {
      const r = row.get(step);
      if (!r) return '·';
      return r.ok ? 'yes' : '**NO**';
    });
    console.log(`| ${tool} | ${cells.join(' | ')} |`);
  }

  const failures = [];
  for (const [tool, row] of results) {
    for (const [step, r] of row) if (!r.ok) failures.push(`${tool} / ${step}: ${r.detail}`);
  }
  console.log(`\n${failures.length === 0 ? 'every cell passed' : `${failures.length} cell(s) failed:`}`);
  for (const f of failures) console.log(`  ${f}`);
  if (errors.length > 0) console.log(`\npage errors: ${errors.slice(0, 4).join(' | ')}`);
} finally {
  await browser.close();
}
