/**
 * Did anything get slower?
 *
 *   node tools/perf-check.mjs            # measure, compare, exit non-zero on a regression
 *   node tools/perf-check.mjs --run out.json   # compare a run already measured
 *
 * The hard part of a performance gate is not measuring, it is deciding what
 * counts. Frame times on a shared machine wander by a few milliseconds between
 * runs for reasons that have nothing to do with the code - this milestone
 * measured the same twenty studies at p95 33.4ms and 16.7ms an hour apart - so
 * a gate that fails on any increase fails constantly and is then ignored,
 * which is worse than no gate.
 *
 * So the rules below are about the shape of the distribution rather than about
 * a number moving:
 *
 *   - p95 has to get worse by BOTH 8ms and a half again before it counts. A
 *     16.7ms frame becoming 18ms is noise; becoming 33ms is a dropped frame.
 *   - a scenario that had no frame over 50ms may not start having them. That
 *     is the threshold a hand feels, and zero is a fact rather than an average.
 *   - long tasks may not grow by more than three. A long task is 50ms of the
 *     main thread with nothing else able to run.
 *
 * A regression names the scenario, the measurement and both numbers, because a
 * gate that says "performance regressed" and stops is a gate nobody can act
 * on.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASELINE = 'tests/browser/baselines/performance.json';
const argv = process.argv.slice(2);
const RUN = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] ?? null : null;

const P95_ABSOLUTE_MS = 8;
const P95_RELATIVE = 1.5;
const LONG_TASK_GROWTH = 3;

if (!existsSync(BASELINE)) {
  console.error(
    `No baseline at ${BASELINE}. Record one first:\n  node tools/perf-baseline.mjs --save`,
  );
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

let runPath = RUN;
let temporary = false;
if (!runPath) {
  runPath = join(tmpdir(), `atlas-perf-${Date.now()}.json`);
  temporary = true;
  console.log('measuring...\n');
  execFileSync('node', ['tools/perf-baseline.mjs', '--json', runPath], { stdio: 'inherit' });
}

const run = JSON.parse(readFileSync(runPath, 'utf8'));
if (temporary) rmSync(runPath, { force: true });

const number = (value) => {
  const n = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const byName = new Map(baseline.rows.map((row) => [row.scenario, row]));
const regressions = [];
const improvements = [];
const missing = [];

for (const now of run.rows) {
  const then = byName.get(now.scenario);
  if (!then) {
    missing.push(`${now.scenario} is new since the baseline`);
    continue;
  }

  const p95Then = number(then.frameP95);
  const p95Now = number(now.frameP95);
  if (p95Then !== null && p95Now !== null) {
    if (p95Now - p95Then >= P95_ABSOLUTE_MS && p95Now >= p95Then * P95_RELATIVE) {
      regressions.push(`${now.scenario}: frame p95 ${p95Then}ms → ${p95Now}ms`);
    } else if (p95Then - p95Now >= P95_ABSOLUTE_MS) {
      improvements.push(`${now.scenario}: frame p95 ${p95Then}ms → ${p95Now}ms`);
    }
  }

  const over50Then = number(then.over50) ?? 0;
  const over50Now = number(now.over50) ?? 0;
  if (over50Then === 0 && over50Now > 0) {
    regressions.push(`${now.scenario}: frames over 50ms 0 → ${over50Now}`);
  }

  const longThen = number(then.longTasks) ?? 0;
  const longNow = number(now.longTasks) ?? 0;
  if (longNow - longThen > LONG_TASK_GROWTH) {
    regressions.push(`${now.scenario}: long tasks ${longThen} → ${longNow}`);
  }
}

for (const row of baseline.rows) {
  if (!run.rows.some((now) => now.scenario === row.scenario)) {
    missing.push(`${row.scenario} was measured in the baseline and is not in this run`);
  }
}

console.log(`\nbaseline recorded ${baseline.recordedAt}`);
console.log(`this run       ${run.recordedAt}`);
console.log(`scenarios      ${run.rows.length} measured, ${baseline.rows.length} in the baseline`);

if (improvements.length > 0) {
  console.log(`\nfaster:\n${improvements.map((line) => `  ${line}`).join('\n')}`);
}
if (missing.length > 0) {
  console.log(`\nnot compared:\n${missing.map((line) => `  ${line}`).join('\n')}`);
}

if (regressions.length === 0) {
  console.log('\nno regression.');
  process.exit(0);
}

console.log(`\nREGRESSION:\n${regressions.map((line) => `  ${line}`).join('\n')}`);
console.log(
  '\nIf the change is deliberate, re-record with:\n  node tools/perf-baseline.mjs --save',
);
process.exit(1);
