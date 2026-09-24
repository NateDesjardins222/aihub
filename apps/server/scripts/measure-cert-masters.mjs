/**
 * One-off calibration tool (M6.1): measure the approved certificate masters.
 * Detects canvas dimensions and the bright horizontal "blank line" placement
 * zones (recipient underline, value underline, top-right date line) so the v1
 * manifests can be calibrated to the ACTUAL pixels rather than guessed. Also
 * converts each supplied webp to a lossless master.png next to it.
 *
 *   node scripts/measure-cert-masters.mjs <srcDir>
 */
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = process.argv[2];
const MAP = [
  ['4.webp', 'funded-trader'],
  ['5.webp', 'payout'],
  ['6.webp', '10k-club'],
  ['7.webp', 'account-completed'],
  ['8.webp', '50k-club'],
];

/** Longest run of "bright" pixels in a row, with its x-extent. */
function brightestRun(data, w, y, thresh) {
  let best = { len: 0, start: 0, end: 0 };
  let runStart = -1;
  for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4;
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (lum > thresh) {
      if (runStart < 0) runStart = x;
    } else {
      if (runStart >= 0) {
        const len = x - runStart;
        if (len > best.len) best = { len, start: runStart, end: x - 1 };
        runStart = -1;
      }
    }
  }
  if (runStart >= 0) {
    const len = w - runStart;
    if (len > best.len) best = { len, start: runStart, end: w - 1 };
  }
  return best;
}

/** Cluster consecutive rows whose longest bright run exceeds minLen into line segments. */
function detectLines(data, w, h, { minLen, xMin = 0, xMax = 1, yMin = 0, yMax = 1, thresh = 110 }) {
  const segs = [];
  let cur = null;
  for (let y = Math.floor(h * yMin); y < Math.floor(h * yMax); y += 1) {
    const run = brightestRun(data, w, y, thresh);
    const cx = (run.start + run.end) / 2;
    const inX = cx >= w * xMin && cx <= w * xMax;
    if (run.len >= minLen && inX) {
      if (!cur) cur = { y0: y, y1: y, runs: [run] };
      else { cur.y1 = y; cur.runs.push(run); }
    } else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  return segs.map((s) => {
    const mid = s.runs[Math.floor(s.runs.length / 2)];
    return {
      yCenter: Math.round((s.y0 + s.y1) / 2),
      thickness: s.y1 - s.y0 + 1,
      xStart: mid.start, xEnd: mid.end,
      xCenter: Math.round((mid.start + mid.end) / 2),
      width: mid.end - mid.start + 1,
    };
  });
}

for (const [file, key] of MAP) {
  const img = await loadImage(join(SRC, file));
  const w = img.width, h = img.height;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getContext ? ctx.getImageData(0, 0, w, h) : ctx.getImageData(0, 0, w, h);

  // Central long underlines (recipient + value): long runs near the horizontal centre.
  const central = detectLines(data, w, h, { minLen: Math.floor(w * 0.16), xMin: 0.25, xMax: 0.75, yMin: 0.45, yMax: 0.82, thresh: 70 });
  // Top-right date line: a shorter run in the top-right quadrant.
  const dateLines = detectLines(data, w, h, { minLen: Math.floor(w * 0.08), xMin: 0.62, xMax: 0.98, yMin: 0.05, yMax: 0.22, thresh: 90 });

  // Save the lossless PNG master next to the source.
  const png = canvas.toBuffer('image/png');
  writeFileSync(join(SRC, `${key}.master.png`), png);

  console.log(JSON.stringify({ key, w, h, central, dateLines }, null, 2));
}
