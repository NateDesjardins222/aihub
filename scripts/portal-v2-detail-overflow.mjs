/**
 * Portal V2 Account Detail overflow test — REAL browser (Product Rebuild Phase 2,
 * STEP 37/38/39).
 *
 * Renders the V2 detail surface (header + headline + tabs + metric rows + progress
 * + rule rows + a wide table) with the ACTUAL V2 CSS from disk at every target
 * width, using DIFFICULT values (very long masked id, >$1,000,000 balance, large
 * negative P&L, long product/rule labels), and asserts:
 *   - no document horizontal overflow (the document never scrolls sideways),
 *   - no element escapes the content column,
 *   - the tab row wraps rather than overflowing,
 *   - a wide table is contained by its own scroll region (doc stays put),
 *   - no negative dimensions.
 *
 * Uses the pre-installed Chromium. Run: node scripts/portal-v2-detail-overflow.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = join(here, '..', 'apps', 'web', 'src', 'portal', 'v2');
const css = ['tokens.css', 'type.css', 'primitives.css', 'AccountDetail.css', 'Lifecycle.css']
  .map((f) => readFileSync(join(v2, f), 'utf8'))
  .join('\n');

const WIDTHS = [1920, 1440, 1280, 1024, 768, 390];

const LONG_PRODUCT = 'SUPER-LONG PRODUCT NAME THAT SHOULD ELLIPSIZE OR WRAP CLEANLY 300K';
const LONG_ID = '•••• HUGE-000123456789';

function metricRow(label, value) {
  return `<div class="htv2-metric-row"><span class="ht-t-label">${label}</span><span class="ht-t-fin-sm ht-num">${value}</span></div>`;
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} html,body{margin:0;padding:0;background:#09090a}
    ${css}
    .wrap{ padding:24px; max-width: 1100px; margin: 0 auto; }
  </style></head><body>
    <div class="htv2"><div class="wrap">
      <div class="htv2-detail" id="detail">
        <button class="htv2-detail-back ht-t-nav">← Accounts</button>
        <header class="htv2-detail-head">
          <div class="htv2-detail-id">
            <div class="htv2-detail-product ht-t-section">${LONG_PRODUCT}</div>
            <div class="htv2-detail-masked ht-t-meta ht-num">Account ${LONG_ID} · A Very Long Nickname That Someone Typed</div>
          </div>
          <div class="htv2-detail-head-right">
            <span class="htv2-status htv2-status-funded ht-t-status"><span class="htv2-status-dot"></span>Funded</span>
            <button class="htv2-btn htv2-btn-primary htv2-btn-sm ht-t-button">Trade →</button>
          </div>
        </header>
        <div class="htv2-detail-headline">
          <div class="htv2-detail-balance">
            <div class="htv2-detail-balance-value ht-t-display ht-num">$1,284,500</div>
            <div class="ht-t-label">Balance</div>
          </div>
          <div class="htv2-detail-headmetrics">
            <div class="htv2-detail-headmetric"><span class="ht-t-label">Net P&amp;L</span><span class="ht-t-fin-md ht-num htv2-tone-negative">-$1,134,500</span></div>
            <div class="htv2-detail-headmetric"><span class="ht-t-label">MLL room</span><span class="ht-t-fin-md ht-num">$1,140,500</span></div>
          </div>
        </div>
        <div class="htv2-detail-tabs">
          ${['Overview', 'Performance', 'Controls', 'Rules', 'Activity'].map((t, i) => `<button class="htv2-detail-tab ht-t-nav${i === 0 ? ' on' : ''}">${t}</button>`).join('')}
        </div>
        <div class="htv2-detail-body">
          <div class="htv2-progress-block">
            <div class="htv2-progress-figs"><span class="ht-t-fin-lg ht-num">$1,134,500</span><span class="ht-t-body-sm htv2-progress-of"> / $6,000</span><span class="ht-t-fin-md ht-num htv2-progress-pct">100.0%</span></div>
            <div class="htv2-progress-bar"><span class="htv2-progress-fill" style="width:100%"></span></div>
          </div>
          <div class="htv2-metric-rows">
            ${metricRow('Balance', '$1,284,500')}
            ${metricRow('Starting balance', '$150,000')}
            ${metricRow('Maximum loss · Trailing (end of day)', '$4,000')}
            ${metricRow('A Very Long Rule Descriptor Label That Might Wrap', '50.0%')}
          </div>
          <ol class="htv2-life" style="--htv2-life-n:4">
            ${['Evaluation', 'Funded', 'Payouts', 'Completed'].map((s, i) => `<li class="htv2-life-stage${i === 0 ? ' first' : ''}${i === 3 ? ' last' : ''}"><span class="htv2-life-track"><span class="htv2-life-line htv2-life-line-l"></span><span class="htv2-life-dot"></span><span class="htv2-life-line htv2-life-line-r"></span></span><span class="htv2-life-label ht-t-meta">${s}</span></li>`).join('')}
          </ol>
          <div class="htv2-table-wrap">
            <table class="htv2-table" id="wide">
              <thead><tr><th>Instrument</th><th class="num">Trades</th><th class="num">Net P&amp;L</th><th class="num">Win rate</th></tr></thead>
              <tbody>
                <tr><td>MNQ</td><td class="num ht-num">1,284</td><td class="num ht-num">+$1,134,500</td><td class="num ht-num">58.2%</td></tr>
                <tr><td>MES</td><td class="num ht-num">640</td><td class="num ht-num">-$12,300</td><td class="num ht-num">47.0%</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
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
      const root = document.getElementById('detail');
      const rootBox = root.getBoundingClientRect();
      const all = [...root.querySelectorAll('*')];
      let escape = 0;
      let negative = false;
      for (const el of all) {
        const b = el.getBoundingClientRect();
        if (b.width < 0 || b.height < 0) negative = true;
        // Ignore the table's inner content (allowed to be wider than its scroll box).
        if (el.closest('.htv2-table-wrap') && !el.classList.contains('htv2-table-wrap')) continue;
        escape = Math.max(escape, b.right - rootBox.right - 0.5);
      }
      const tabs = document.querySelector('.htv2-detail-tabs');
      const wide = document.getElementById('wide');
      const wrap = wide.closest('.htv2-table-wrap');
      return {
        docOverflow: doc.scrollWidth - doc.clientWidth,
        escape: Math.max(0, escape),
        negative,
        tabsOverflow: tabs.scrollWidth - tabs.clientWidth, // should be ~0 (wraps)
        tableContained: wide.scrollWidth > wrap.clientWidth ? 'scrolls-internally' : 'fits',
      };
    });
    await page.close();
    const ok = r.docOverflow <= 1 && r.escape <= 1 && !r.negative && r.tabsOverflow <= 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(w).padStart(4)}px  docOverflow=${r.docOverflow}  escape=${r.escape.toFixed(1)}  tabsOverflow=${r.tabsOverflow}  table=${r.tableContained}  negative=${r.negative}`);
    if (!ok) failures += 1;
  }
} finally {
  await browser.close();
}
if (failures > 0) {
  console.error(`\nDETAIL OVERFLOW: ${failures} width(s) failed.`);
  process.exit(1);
}
console.log('\nDETAIL OVERFLOW: all widths contained. ✓');
