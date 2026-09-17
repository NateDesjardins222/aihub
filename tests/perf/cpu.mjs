/**
 * Where a gesture's time actually goes.
 *
 * Takes a CPU profile through the debugging protocol while one gesture runs,
 * and prints the functions with the most self time. Run against the
 * DEVELOPMENT server, where function names survive; the magnitudes are
 * inflated by StrictMode but the ordering is what this is for.
 *
 * Run: node tests/perf/cpu.mjs [gesture]
 */
import { launch, signIn } from '../browser/harness.mjs';

const GESTURE = process.argv[2] ?? 'crosshair';

const { browser, page } = await launch({ width: 1680, height: 950 });
const cdp = await page.context().newCDPSession(page);

try {
  await signIn(page);
  await page.waitForTimeout(2_000);
  const box = await page.locator('.chart-canvas').boundingBox();
  const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');

  if (GESTURE === 'crosshair') {
    for (let i = 0; i < 200; i += 1) {
      const fx = 0.2 + (i / 200) * 0.6;
      const fy = 0.35 + Math.sin(i / 7) * 0.2;
      await page.mouse.move(at(fx, fy).x, at(fx, fy).y);
    }
  } else if (GESTURE === 'pan') {
    await page.mouse.move(at(0.9, 0.06).x, at(0.9, 0.06).y);
    await page.mouse.down();
    for (let i = 0; i < 150; i += 1) await page.mouse.move(at(0.9 - i * 0.004, 0.06).x, at(0.9, 0.06).y);
    await page.mouse.up();
  } else if (GESTURE === 'idle') {
    await page.waitForTimeout(5_000);
  }

  const { profile } = await cdp.send('Profiler.stop');

  // Self time per function, from the sample counts.
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length);
  for (const id of profile.samples) {
    const node = byId.get(id);
    if (!node) continue;
    const frame = node.callFrame;
    const where = frame.url ? frame.url.split('/').slice(-1)[0] : '(native)';
    const name = `${frame.functionName || '(anonymous)'}  ${where}:${frame.lineNumber + 1}`;
    self.set(name, (self.get(name) ?? 0) + interval / 1000);
  }

  const total = [...self.values()].reduce((sum, ms) => sum + ms, 0);
  console.log(`\n=== ${GESTURE}: ${Math.round(total)}ms of samples ===\n`);
  for (const [name, ms] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) {
    if (ms < 1) break;
    console.log(`${String(Math.round(ms)).padStart(6)}ms  ${(ms / total * 100).toFixed(1).padStart(5)}%  ${name}`);
  }
} finally {
  await browser.close();
}
