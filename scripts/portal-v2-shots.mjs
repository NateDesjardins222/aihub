/** Dev-only: capture Portal V2 review screenshots for adversarial visual review. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOT_DIR ?? '/tmp/pv2-shots';
mkdirSync(OUT, { recursive: true });
const BASE = 'http://localhost:5173';
const shots = [
  { name: 'dashboard-1440', url: '/portal-v2', w: 1440, h: 900 },
  { name: 'dashboard-1920', url: '/portal-v2', w: 1920, h: 1080 },
  { name: 'accounts-1440', url: '/portal-v2/accounts', w: 1440, h: 900 },
  { name: 'eval-detail-1440', url: '/portal-v2/accounts/f-eval', w: 1440, h: 900 },
  { name: 'funded-detail-1440', url: '/portal-v2/accounts/f-large', w: 1440, h: 900 },
  { name: 'payouts-1440', url: '/portal-v2/payouts', w: 1440, h: 900 },
  { name: 'certificates-1440', url: '/portal-v2/certificates', w: 1440, h: 900 },
  { name: 'billing-1440', url: '/portal-v2/billing', w: 1440, h: 900 },
  { name: 'support-1440', url: '/portal-v2/support', w: 1440, h: 900 },
  { name: 'profile-1440', url: '/portal-v2/profile', w: 1440, h: 900 },
  { name: 'dashboard-empty-1440', url: '/portal-v2?state=empty', w: 1440, h: 900 },
  { name: 'accounts-empty-1440', url: '/portal-v2/accounts?state=empty', w: 1440, h: 900 },
  { name: 'certificates-empty-1440', url: '/portal-v2/certificates?state=empty', w: 1440, h: 900 },
  { name: 'dashboard-390', url: '/portal-v2', w: 390, h: 844 },
  { name: 'accounts-390', url: '/portal-v2/accounts', w: 390, h: 844 },
  { name: 'dashboard-1280', url: '/portal-v2', w: 1280, h: 720 },
  { name: 'dashboard-768', url: '/portal-v2', w: 768, h: 1024 },
  // Experience Layer Phase 1 — Progress & Achievements.
  { name: 'progress-1920', url: '/portal-v2/progress', w: 1920, h: 1080, full: true },
  { name: 'progress-1440', url: '/portal-v2/progress', w: 1440, h: 900, full: true },
  { name: 'progress-1024', url: '/portal-v2/progress', w: 1024, h: 768, full: true },
  { name: 'progress-768', url: '/portal-v2/progress', w: 768, h: 1024, full: true },
  { name: 'progress-390', url: '/portal-v2/progress', w: 390, h: 844, full: true },
  { name: 'progress-empty-1440', url: '/portal-v2/progress?state=empty', w: 1440, h: 900, full: true },
  { name: 'billing-1440-exp', url: '/portal-v2/billing', w: 1440, h: 900 },
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium', headless: true });
try {
  for (const s of shots) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 });
    await page.goto(`${BASE}${s.url}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}/${s.name}.png`, fullPage: s.full === true });
    console.log(`shot ${s.name} (${s.w}x${s.h})`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('done ->', OUT);
