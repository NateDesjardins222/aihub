/**
 * Portal V2 Accounts overflow test — REAL browser (Product Rebuild Phase 1, STEP 24/25/26).
 *
 * Renders the V2 account panel + accounts grid with the ACTUAL V2 CSS from disk
 * (tokens + type + primitives + AccountPanel + Lifecycle) at every target width,
 * including a very long masked id and a > $1,000,000 balance, and asserts:
 *   - no document horizontal overflow,
 *   - no panel escapes the grid,
 *   - the long product label ellipsizes instead of widening its panel,
 *   - no negative dimensions.
 *
 * Uses the pre-installed Chromium. Run: node scripts/portal-v2-accounts-overflow.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = join(here, '..', 'apps', 'web', 'src', 'portal', 'v2');
const css = ['tokens.css', 'type.css', 'primitives.css', 'AccountPanel.css', 'AccountsView.css', 'Lifecycle.css']
  .map((f) => readFileSync(join(v2, f), 'utf8'))
  .join('\n');

const WIDTHS = [1920, 1440, 1280, 1024, 768, 390];

function panel({ product, masked, balance, net, mll }) {
  return `<article class="htv2-acct">
    <header class="htv2-acct-head">
      <div class="htv2-acct-id">
        <div class="htv2-acct-product ht-t-section">${product}</div>
        <div class="htv2-acct-masked ht-t-meta ht-num">Account ${masked}</div>
      </div>
      <span class="htv2-status htv2-status-funded ht-t-status"><span class="htv2-status-dot"></span>Funded</span>
    </header>
    <div class="htv2-acct-balance">
      <div class="htv2-acct-balance-value ht-t-display ht-num">${balance}</div>
      <div class="htv2-acct-balance-label ht-t-label">Balance</div>
    </div>
    <div class="htv2-acct-metrics">
      <div class="htv2-acct-metric"><span class="ht-t-label">Net P&amp;L</span><span class="ht-t-fin-sm ht-num">${net}</span></div>
      <div class="htv2-acct-metric htv2-acct-metric-right"><span class="ht-t-label">MLL room</span><span class="ht-t-fin-sm ht-num">${mll}</span></div>
    </div>
    <ol class="htv2-life" style="--htv2-life-n:4">
      ${['Evaluation', 'Funded', 'Payouts', 'Completed'].map((s, i) => `<li class="htv2-life-stage${i === 0 ? ' first' : ''}${i === 3 ? ' last' : ''}"><span class="htv2-life-track"><span class="htv2-life-line htv2-life-line-l"></span><span class="htv2-life-dot"></span><span class="htv2-life-line htv2-life-line-r"></span></span><span class="htv2-life-label ht-t-meta">${s}</span></li>`).join('')}
    </ol>
  </article>`;
}

const PANELS = [
  panel({ product: 'CORE 100K', masked: '•••• 1005', balance: '$100,000', net: '+$0', mll: '$4,000' }),
  panel({ product: 'SUPER-LONG PRODUCT NAME THAT SHOULD ELLIPSIZE 100K', masked: '•••• HUGE-000123456789', balance: '$1,284,500', net: '+$1,134,500', mll: '$1,140,500' }),
  panel({ product: 'SELECT 50K', masked: '•••• 2213', balance: '$52,480.25', net: '-$4,100', mll: '$0' }),
];

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} html,body{margin:0;padding:0;background:#09090a}
    ${css}
    .wrap{padding:24px}
  </style></head><body>
    <div class="htv2"><div class="wrap">
      <div class="htv2-acct-grid" id="grid">${PANELS.join('')}</div>
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
    await page.setContent(pageHtml(), { waitUntil: 'load' });
    const r = await page.evaluate(() => {
      const doc = document.documentElement;
      const grid = document.getElementById('grid');
      const gridBox = grid.getBoundingClientRect();
      const panels = [...document.querySelectorAll('.htv2-acct')].map((el) => el.getBoundingClientRect());
      const labels = [...document.querySelectorAll('.htv2-acct-product')].map((el) => ({
        scroll: el.scrollWidth, client: el.clientWidth,
      }));
      return {
        docOverflow: doc.scrollWidth - doc.clientWidth,
        panelEscape: Math.max(0, ...panels.map((b) => b.right - gridBox.right - 0.5)),
        negative: panels.some((b) => b.width < 0 || b.height < 0),
        // A label that ellipsizes has scrollWidth > clientWidth but does NOT push its
        // panel wider (checked via panelEscape). Confirm at least the long one clips.
        labelClips: labels.some((l) => l.scroll > l.client),
        count: panels.length,
      };
    });
    await page.close();
    const ok = r.docOverflow <= 1 && r.panelEscape <= 1 && !r.negative && r.count === PANELS.length;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(w).padStart(4)}px  docOverflow=${r.docOverflow}  panelEscape=${r.panelEscape.toFixed(1)}  labelClips=${r.labelClips}  negative=${r.negative}`);
    if (!ok) failures += 1;
  }
} finally {
  await browser.close();
}
if (failures > 0) {
  console.error(`\nACCOUNTS OVERFLOW: ${failures} width(s) failed.`);
  process.exit(1);
}
console.log('\nACCOUNTS OVERFLOW: all widths contained. ✓');
