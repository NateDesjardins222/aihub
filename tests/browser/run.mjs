/**
 * Run every browser suite and report once.
 *
 * Sequential on purpose: the suites share one account and one market, and
 * running them together would have them close each other's positions.
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
  'stress',
  'perf-panes',
  'pane-resize',
  'abuse',
  'live-indicators',
  'recovery',
  'appearance',
  'tablet',
  'visual',
  'polish',
  'tools',
  'replay-brackets',
  'layout',
  'admin',
  'acceptance',
];
const only = process.argv.slice(2);
const chosen = only.length > 0 ? SUITES.filter((s) => only.includes(s)) : SUITES;

mkdirSync(process.env.ATLAS_SHOTS ?? '/tmp/atlas-shots', { recursive: true });

let failures = 0;
for (const suite of chosen) {
  console.log(`\n${'='.repeat(64)}\n${suite}\n${'='.repeat(64)}`);
  const result = spawnSync(process.execPath, [join(here, `${suite}.spec.mjs`)], { stdio: 'inherit' });
  failures += result.status ?? 1;
}

console.log(`\n${failures === 0 ? 'all browser suites passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
