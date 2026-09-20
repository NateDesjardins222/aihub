/**
 * Run every browser suite and report once.
 *
 *   node tests/browser/run.mjs                    # every suite, in order
 *   node tests/browser/run.mjs terminal visual    # just these
 *   node tests/browser/run.mjs --shuffle          # in a random order
 *   node tests/browser/run.mjs --shuffle --seed 7 # that order again
 *
 * Sequential on purpose: the suites share one account and one market, and
 * running them together would have them close each other's positions.
 *
 * THE ORDER IS PART OF WHAT IS BEING TESTED. A suite that only passes after
 * the suite before it has left the terminal in some particular state is not a
 * passing suite, it is a coincidence - and five separate kinds of inherited
 * state have already been found that way (see D-004 in the diagnostics
 * ledger). `--shuffle` deals a different order every time, and `--seed`
 * replays the one that failed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  'terminal',
  'responsive',
  'chart-navigation',
  'indicators',
  'drawing-pointer',
  'drawing-engine',
  'position-tools',
  'fib-levels',
  'multi-chart',
  'journal-calendar',
  'journal-scale',
  'rectangle',
  'line-tools',
  'remaining-tools',
  'drag-protect',
  'execution-interaction',
  'execution-stress',
  'execution-safety',
  'stress',
  'perf-panes',
  'pane-resize',
  'abuse',
  'live-indicators',
  'recovery',
  'reconnect',
  'appearance',
  'tablet',
  'visual',
  'polish',
  'first-run',
  'tools',
  'charting-v3',
  'replay-brackets',
  'layout',
  'admin',
  'acceptance',
];
const argv = process.argv.slice(2);
const SHUFFLE = argv.includes('--shuffle');
const SEED = argv.includes('--seed') ? Number(argv[argv.indexOf('--seed') + 1]) : Date.now() % 100_000;
const only = argv.filter((a) => !a.startsWith('--') && a !== String(SEED));
let chosen = only.length > 0 ? SUITES.filter((s) => only.includes(s)) : [...SUITES];

if (SHUFFLE) {
  // Mulberry32, so an order that found something can be dealt again.
  let a = SEED >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = chosen.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
  }
  console.log(`shuffled with --seed ${SEED}:\n  ${chosen.join(' ')}\n`);
}

mkdirSync(process.env.ATLAS_SHOTS ?? '/tmp/atlas-shots', { recursive: true });

let failures = 0;
for (const suite of chosen) {
  console.log(`\n${'='.repeat(64)}\n${suite}\n${'='.repeat(64)}`);
  const result = spawnSync(process.execPath, [join(here, `${suite}.spec.mjs`)], { stdio: 'inherit' });
  failures += result.status ?? 1;
}

console.log(
  `\n${failures === 0 ? 'all browser suites passed' : `${failures} check(s) failed`}` +
    (SHUFFLE ? ` (order --seed ${SEED})` : ''),
);
process.exit(failures === 0 ? 0 : 1);
