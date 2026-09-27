/**
 * Portal V2 lifecycle overflow test — REAL browser (Product Rebuild Phase 0, STEP 18).
 *
 * Renders the V2Lifecycle markup with the actual tokens.css + Lifecycle.css from
 * disk, inside a representative account-card container, and asserts at every target
 * width that:
 *   - the document has no horizontal overflow (scrollWidth <= clientWidth),
 *   - the lifecycle component does not exceed its container,
 *   - no stage escapes the component's bounding box,
 *   - no element has a negative dimension.
 *
 * Deterministic, headless, uses the pre-installed Chromium. Run:
 *   node scripts/portal-v2-lifecycle-overflow.mjs
 * Exits non-zero on any overflow.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = join(here, '..', 'apps', 'web', 'src', 'portal', 'v2');
const tokens = readFileSync(join(v2, 'tokens.css'), 'utf8');
const lifecycleCss = readFileSync(join(v2, 'Lifecycle.css'), 'utf8');

const STAGES = ['Evaluation', 'Funded', 'Payouts', 'Completed'];
const WIDTHS = [1920, 1440, 1280, 1024, 768, 390];
// The account card the lifecycle sits inside is a fraction of the viewport; model
// a realistic narrow card column so the test is meaningful, not just full-bleed.
const CARD_WIDTHS = { 1920: 300, 1440: 300, 1280: 300, 1024: 300, 768: 340, 390: 320 };

function stageHtml(label, i) {
  const first = i === 0 ? ' first' : '';
  const last = i === STAGES.length - 1 ? ' last' : '';
  return `<li class="htv2-life-stage${first}${last}">
    <span class="htv2-life-track">
      <span class="htv2-life-line htv2-life-line-l"></span>
      <span class="htv2-life-dot"></span>
      <span class="htv2-life-line htv2-life-line-r"></span>
    </span>
    <span class="htv2-life-label ht-t-meta">${label}</span>
  </li>`;
}

function pageHtml(cardWidth) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} html,body{margin:0;padding:0;background:#09090a}
    .ht-t-meta{font-family:sans-serif;font-size:11px}
    ${tokens}
    ${lifecycleCss}
    .card{width:${cardWidth}px;margin:24px;padding:20px;border:1px solid #19191c;border-radius:8px}
  </style></head><body>
    <div class="htv2"><div class="card" id="card">
      <ol class="htv2-life" id="life" style="--htv2-life-n:${STAGES.length}">
        ${STAGES.map(stageHtml).join('')}
      </ol>
    </div></div>
  </body></html>`;
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium',
  headless: true,
});
let failures = 0;
try {
  for (const w of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: 900 } });
    await page.setContent(pageHtml(CARD_WIDTHS[w]), { waitUntil: 'load' });
    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const card = document.getElementById('card');
      const life = document.getElementById('life');
      const cardBox = card.getBoundingClientRect();
      const lifeBox = life.getBoundingClientRect();
      const stages = [...document.querySelectorAll('.htv2-life-stage')].map((el) => {
        const b = el.getBoundingClientRect();
        return { right: b.right, left: b.left, w: b.width, h: b.height };
      });
      return {
        docOverflow: doc.scrollWidth - doc.clientWidth,
        lifeOverCard: lifeBox.right - cardBox.right,
        lifeWidth: lifeBox.width,
        stageEscape: Math.max(0, ...stages.map((s) => s.right - lifeBox.right - 0.5)),
        negative: stages.some((s) => s.w < 0 || s.h < 0),
        stageCount: stages.length,
      };
    });
    await page.close();

    const ok =
      r.docOverflow <= 1 &&
      r.lifeOverCard <= 1 &&
      r.stageEscape <= 1 &&
      !r.negative &&
      r.stageCount === STAGES.length;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${String(w).padStart(4)}px  card=${CARD_WIDTHS[w]}  ` +
        `docOverflow=${r.docOverflow}  lifeOverCard=${r.lifeOverCard.toFixed(1)}  ` +
        `stageEscape=${r.stageEscape.toFixed(1)}  negative=${r.negative}`,
    );
    if (!ok) failures += 1;
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\nLIFECYCLE OVERFLOW: ${failures} width(s) failed.`);
  process.exit(1);
}
console.log('\nLIFECYCLE OVERFLOW: all widths contained. ✓');
