/**
 * Golden certificate render (M6.1 visual calibration). Renders each v1 production
 * template with the approved example values and writes PNGs for visual comparison
 * against the approved masters. Uses the SAME manifest + renderer the product uses.
 * Dev-only calibration tool; does not touch the database.
 *
 *   node scripts/render-golden-certs.mjs <outDir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { readFileSync, existsSync } from 'node:fs';

const OUT = process.argv[2] ?? '/tmp/golden';
mkdirSync(OUT, { recursive: true });

const ROOT = join(process.cwd(), '..', '..', 'certificate-templates');
const fontsDir = join(ROOT, '_fonts');
for (const [file, fam] of [['HappyTraderSans-Regular.ttf', 'HappyTraderSans'], ['HappyTraderSans-Bold.ttf', 'HappyTraderSans'], ['HappyTraderSerif-Regular.ttf', 'HappyTraderSerif']]) {
  const p = join(fontsDir, file); if (existsSync(p)) GlobalFonts.registerFromPath(p, fam);
}

const GOLDEN = [
  ['funded-trader', { recipientName: 'NATETRADEZ', value: '50K', date: '2026-09-23' }],
  ['payout', { recipientName: 'NATETRADEZ', value: '$5,000', date: '2026-09-23' }],
  ['account-completed', { recipientName: 'NATETRADEZ', value: '$25,000', date: '2026-09-23' }],
  ['10k-club', { recipientName: 'NATETRADEZ', value: '$10,000', date: '2026-09-23' }],
  ['50k-club', { recipientName: 'NATETRADEZ', value: '$50,000', date: '2026-09-23' }],
  // A deliberately long name to confirm deterministic shrink stays inside the region.
  ['funded-trader', { recipientName: 'MAXIMILIAN ALEXANDER WORTHINGTON III', value: '300K', date: '2026-12-31' }, 'funded-trader-longname'],
];

function drawField(ctx, text, f) {
  if (!text) return;
  ctx.fillStyle = f.color; ctx.textAlign = f.alignment; ctx.textBaseline = 'middle';
  try { ctx.letterSpacing = `${f.letterSpacing ?? 0}px`; } catch {}
  let size = f.fontSize; const floor = Math.max(8, Math.floor(f.fontSize * 0.4));
  const setFont = (px) => { ctx.font = `${f.fontWeight ?? 400} ${px}px "${f.fontFamily}"`; };
  setFont(size);
  if ((f.overflow ?? 'shrink') === 'shrink') while (size > floor && ctx.measureText(text).width > f.width) { size -= 2; setFont(size); }
  ctx.fillText(text, f.x, f.y);
}

for (const [key, fields, alias] of GOLDEN) {
  const man = JSON.parse(readFileSync(join(ROOT, key, 'v1', 'manifest.json'), 'utf8'));
  const master = readFileSync(join(ROOT, key, 'v1', 'master.png'));
  const { width, height } = man.canvas;
  const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
  const img = await loadImage(master); ctx.drawImage(img, 0, 0, width, height);
  for (const name of Object.keys(man.fields).sort()) if (fields[name] != null) drawField(ctx, fields[name], man.fields[name]);
  const png = canvas.toBuffer('image/png');
  const out = join(OUT, `${alias ?? key}.golden.png`);
  writeFileSync(out, png);
  console.log(`${alias ?? key}: ${width}x${height} hash=${createHash('sha256').update(png).digest('hex').slice(0, 12)} -> ${out}`);
}
