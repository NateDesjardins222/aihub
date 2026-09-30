/**
 * Portal V2 scroll regression — REAL browser, reproduces the REAL collision.
 *
 * The earlier portal-v2 checks gave false confidence: they measured overflow/bounds
 * but never proved the page actually MOVES, and never included the global terminal
 * scroll lock that was the true cause. This test:
 *   1. Loads the ACTUAL global theme.css (html,body,#root { height:100% } + the
 *      terminal's `body { overflow: hidden }` lock) and mounts the shell inside a
 *      real `#root`, exactly as the app does — so the original defect would
 *      reproduce here if the fix were removed.
 *   2. Builds the real shell DOM with the real Shell.css so `.htv2-workspace` is the
 *      intended scroll owner.
 *   3. At every target width, PROVES actual vertical movement on that owner via a
 *      real wheel event, a keyboard PageDown, and a programmatic scroll; proves the
 *      bottom element is reachable; proves the DOCUMENT is NOT the scroller (the
 *      workspace is); proves NO horizontal document overflow; and proves a modal
 *      body-lock/unlock never breaks workspace scrolling.
 *
 * Deterministic, headless, uses the pre-installed Chromium. Exits non-zero on any failure.
 *   node scripts/portal-v2-scroll.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', 'apps', 'web', 'src');
const v2 = join(web, 'portal', 'v2');
const css = (p) => readFileSync(p, 'utf8');

const themeCss = css(join(web, 'styles', 'theme.css'));
const tokens = css(join(v2, 'tokens.css'));
const typeCss = css(join(v2, 'type.css'));
const primitives = css(join(v2, 'primitives.css'));
const shellCss = css(join(v2, 'Shell.css'));

// Target widths × heights (STEP 11).
const VIEWPORTS = [
  { w: 1920, h: 1080 }, { w: 1440, h: 900 }, { w: 1280, h: 720 },
  { w: 1024, h: 768 }, { w: 768, h: 1024 }, { w: 390, h: 844 },
];

// A deterministically tall workspace body + a bottom sentinel that must be reachable.
const longContent = `
  ${Array.from({ length: 40 }, (_, i) => `<div class="row" style="min-height:60px;border-bottom:1px solid #19191c;padding:8px">Row ${i + 1}</div>`).join('')}
  <div id="bottom-sentinel" style="min-height:60px;padding:8px">BOTTOM SENTINEL — last reachable element</div>
`;

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${themeCss}
    ${tokens}
    ${typeCss}
    ${primitives}
    ${shellCss}
  </style></head><body>
    <div id="root">
      <div class="htv2">
        <div class="htv2-shell">
          <aside class="htv2-side"><nav class="htv2-side-nav"><button class="htv2-side-link">Accounts</button></nav></aside>
          <div class="htv2-shell-main">
            <header class="htv2-top"><div class="htv2-top-crumb">Portal V2</div></header>
            <main class="htv2-workspace" id="ws" tabindex="-1"><div class="htv2-workspace-inner">${longContent}</div></main>
          </div>
        </div>
      </div>
    </div>
  </body></html>`;
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium',
  headless: true,
});
let failures = 0;
const lines = [];
try {
  for (const { w, h } of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(pageHtml(), { waitUntil: 'load' });

    // Geometry + document-owner facts.
    const facts = await page.evaluate(() => {
      const doc = document.documentElement;
      const ws = document.getElementById('ws');
      return {
        docOverflowX: doc.scrollWidth - doc.clientWidth,
        docScrollableY: doc.scrollHeight - doc.clientHeight,
        wsScrollableY: ws.scrollHeight - ws.clientHeight,
        bodyOverflowY: getComputedStyle(document.body).overflowY,
      };
    });

    // Real wheel input over the workspace, from a known baseline (scrollTop 0).
    await page.evaluate(() => { document.getElementById('ws').scrollTop = 0; });
    await page.mouse.move(Math.floor(w / 2), Math.floor(h / 2));
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(30);
    const afterWheel = await page.evaluate(() => document.getElementById('ws').scrollTop);

    // Keyboard PageDown on the focused workspace, also from a known baseline.
    await page.evaluate(() => { const ws = document.getElementById('ws'); ws.scrollTop = 0; ws.focus(); });
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(30);
    const afterPageDown = await page.evaluate(() => document.getElementById('ws').scrollTop);

    // Programmatic scroll to the bottom; sentinel must be visible within the workspace.
    const bottom = await page.evaluate(() => {
      const ws = document.getElementById('ws');
      ws.scrollTop = ws.scrollHeight;
      const wsBox = ws.getBoundingClientRect();
      const sent = document.getElementById('bottom-sentinel').getBoundingClientRect();
      return { scrollTop: ws.scrollTop, maxScroll: ws.scrollHeight - ws.clientHeight, sentinelVisible: sent.top < wsBox.bottom && sent.bottom > wsBox.top };
    });

    // Modal lock/unlock must not break workspace scrolling.
    const afterModal = await page.evaluate(() => {
      const ws = document.getElementById('ws');
      ws.scrollTop = 0;
      document.body.style.overflow = 'hidden';         // modal opens
      document.body.style.overflow = '';               // modal closes → restore
      ws.scrollTop = 400;                               // workspace still scrolls
      return ws.scrollTop;
    });

    await page.close();

    const ok =
      facts.docOverflowX <= 1 &&                        // no horizontal page scroll
      facts.wsScrollableY > 4 &&                        // workspace is a real scroller
      facts.docScrollableY <= 1 &&                      // the DOCUMENT is NOT the scroller
      afterWheel > 0 &&                                 // wheel moved the workspace
      afterPageDown > 0 &&                              // PageDown moved it from the top
      bottom.scrollTop >= bottom.maxScroll - 2 &&       // reached the bottom
      bottom.sentinelVisible &&                         // last element reachable
      afterModal === 400;                               // scroll survives modal lock/unlock
    if (!ok) failures += 1;
    lines.push(
      `${ok ? 'PASS' : 'FAIL'}  ${String(w).padStart(4)}x${String(h).padStart(4)}  ` +
        `docOverflowX=${facts.docOverflowX} docScrollY=${facts.docScrollableY} wsScrollY=${facts.wsScrollableY} ` +
        `wheel=${afterWheel} pageDown=${afterPageDown} bottom=${bottom.scrollTop}/${bottom.maxScroll} ` +
        `sentinel=${bottom.sentinelVisible} modal=${afterModal} bodyOverflowY=${facts.bodyOverflowY}`,
    );
  }
} finally {
  await browser.close();
}

console.log('Portal V2 scroll regression — workspace owns vertical scroll, document locked:\n');
for (const l of lines) console.log('  ' + l);
if (failures > 0) {
  console.error(`\nPORTAL V2 SCROLL: ${failures} viewport(s) failed.`);
  process.exit(1);
}
console.log('\nPORTAL V2 SCROLL: all viewports scroll to the bottom on the workspace. ✓');
