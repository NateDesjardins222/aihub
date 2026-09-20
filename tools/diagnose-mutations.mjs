/**
 * Do the tests actually catch anything?
 *
 *   node tools/diagnose-mutations.mjs            # every mutation
 *   node tools/diagnose-mutations.mjs --only fee # one of them
 *
 * A passing suite proves the code does what the tests check. It does NOT prove
 * the tests check anything worth checking. The only way to find out is to
 * break the product on purpose and see whether anything screams.
 *
 * Each mutation below is a plausible mistake - a sign flipped, a multiplier
 * wrong, a guard removed - applied to the real source, with the matching tests
 * run against it. A mutation that SURVIVES is a hole in the safety net, and is
 * reported as such.
 *
 * THE SOURCE IS ALWAYS RESTORED. Every mutation is applied, tested and
 * reverted inside a try/finally, and the tree is verified clean at the end. If
 * this script is killed mid-run, `git checkout -- <file>` puts it back.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const ONLY = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? null) : null;

/**
 * Each mutation names the file, the exact text to replace, what it replaces it
 * with, and which tests SHOULD notice. `tests` is a vitest path filter.
 */
const MUTATIONS = [
  {
    id: 'fee-accumulation',
    what: 'fills stop accumulating their commissions onto the position',
    file: 'packages/core/src/position/position.ts',
    custom: (source) =>
      source.replaceAll('feesMicros: position.feesMicros + fill.feesMicros', 'feesMicros: position.feesMicros'),
    tests: 'packages/core',
  },
  {
    id: 'tick-value',
    what: "NQ's tick value is doubled",
    file: 'packages/instruments/src/registry.ts',
    from: "root: 'NQ'",
    to: "root: 'NQ'",
    // Applied by a second, targeted replacement below rather than a string
    // swap, because the registry states the value once per instrument.
    custom: (source) =>
      source.replace(/tickValueMicros: 5_000_000/, 'tickValueMicros: 10_000_000'),
    tests: 'packages/instruments',
  },
  {
    id: 'position-side',
    what: 'a negative quantity no longer reads as SHORT',
    file: 'packages/core/src/position/position.ts',
    from: "if (qty < 0) return 'SHORT';",
    to: "if (qty < -1e9) return 'SHORT';",
    tests: 'packages/core',
  },
  {
    id: 'average-entry',
    what: 'scaling in ignores the new fill when averaging the entry',
    file: 'packages/core/src/position/position.ts',
    from: 'const added = fill.priceTicks * fill.signedQty * spec.tickValueMicros;',
    to: 'const added = 0;',
    tests: 'packages/core',
  },
  {
    id: 'break-even-rounding',
    what: 'break even rounds DOWN, leaving the trader short of the fees',
    file: 'apps/web/src/chart/protection.ts',
    from: 'Math.ceil(roundTurnMicros / tickValueMicros)',
    to: 'Math.floor(roundTurnMicros / tickValueMicros)',
    tests: 'apps/web/src/chart/protection.test.ts',
  },
  {
    id: 'partial-whole-position',
    what: 'a partial is allowed to close the whole position',
    file: 'apps/web/src/chart/protection.ts',
    from: 'Math.max(1, Math.min(size - 1, wanted))',
    to: 'Math.max(1, Math.min(size, wanted))',
    tests: 'apps/web/src/chart/protection.test.ts',
  },
  {
    id: 'audio-on-partial',
    what: 'every partial fill announces "order filled"',
    file: 'apps/web/src/audio/execution-events.ts',
    from: "if (order.status === 'FILLED') {",
    to: "if (order.status === 'FILLED' || order.status === 'PARTIALLY_FILLED') {",
    tests: 'apps/web/src/audio',
  },
  {
    id: 'audio-on-first-read',
    what: 'the first authoritative read replays every old fill out loud',
    file: 'apps/web/src/audio/execution-events.ts',
    from: 'if (previous.orders.size === 0 && previous.positions.size === 0) return [];',
    to: '',
    tests: 'apps/web/src/audio',
    expectSurvive: true,
    note: 'redundant by construction - the unknown-order and zero-before rules already return [] on an empty previous snapshot (D-009)',
  },
  {
    id: 'stale-account-guard',
    what: "a late read is written to whatever account is on screen",
    file: 'apps/web/src/trading/store.ts',
    from: 'if (get().accountId !== accountId) return;\n      /*',
    to: 'if (false) return;\n      /*',
    tests: 'apps/web',
    expectSurvive: true,
    note: 'no unit test covers this; the browser suite does',
  },
  {
    id: 'cross-tab-refresh',
    what: 'the loser of a refresh race stops adopting the token the winner stored',
    file: 'apps/web/src/api/client.ts',
    from: 'if (current !== null && current !== token) {',
    to: 'if (false) {',
    tests: 'apps/web/src/api',
  },
  {
    id: 'refresh-network-failure',
    what: 'a dropped connection during refresh signs the trader out',
    file: 'apps/web/src/api/client.ts',
    from: `  } catch {
    // A network failure is not a bad token: keep the session and let the
    // caller's request fail on its own terms.
    return false;
  }`,
    to: `  } catch {
    setRefreshToken(null);
    setAccessToken(null);
    return false;
  }`,
    tests: 'apps/web/src/api',
  },
  {
    id: 'position-readout-points',
    what: 'the position tool reports ticks where it should report points',
    file: 'apps/web/src/chart/drawings/model.ts',
    from: '`${sign}${value.toFixed(pricePrecision)} pts`',
    to: '`${sign}${Math.round(value)} pts`',
    tests: 'apps/web/src/chart/drawings',
  },
];

const chosen = ONLY ? MUTATIONS.filter((m) => m.id.includes(ONLY)) : MUTATIONS;

function run(tests) {
  try {
    execFileSync('pnpm', ['vitest', 'run', tests, '--silent'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 600_000,
    });
    return { caught: false, output: '' };
  } catch (error) {
    return { caught: true, output: String(error.stdout ?? '').slice(-400) };
  }
}

const results = [];
/** Every touched file as it was found, so the restore can be verified. */
const before = new Map();

for (const mutation of chosen) {
  const original = readFileSync(mutation.file, 'utf8');
  if (!before.has(mutation.file)) before.set(mutation.file, original);
  let mutated;
  if (mutation.custom) {
    mutated = mutation.custom(original);
  } else {
    if (!original.includes(mutation.from)) {
      results.push({ ...mutation, status: 'NOT APPLIED', detail: 'the text to mutate was not found' });
      continue;
    }
    mutated = original.replace(mutation.from, mutation.to);
  }

  if (mutated === original) {
    results.push({ ...mutation, status: 'NOT APPLIED', detail: 'the mutation changed nothing' });
    continue;
  }

  try {
    writeFileSync(mutation.file, mutated);
    process.stdout.write(`applying ${mutation.id}: ${mutation.what}\n`);
    const outcome = run(mutation.tests);
    results.push({
      ...mutation,
      status: outcome.caught ? 'CAUGHT' : 'SURVIVED',
      detail: outcome.caught ? 'a test failed, as it should' : 'every test still passed',
    });
    process.stdout.write(`  ${outcome.caught ? 'CAUGHT' : 'SURVIVED'}\n`);
  } finally {
    // Always. A mutation left in the tree is a disaster of a different kind.
    writeFileSync(mutation.file, original);
  }
}

/*
 * The FILES THIS TOUCHED must be byte-for-byte what they were FOUND as.
 *
 * Not "clean against HEAD": this script runs while the milestone is being
 * worked on, and a file with an uncommitted fix in it is not a file this
 * script damaged. Asking git produced exactly that false alarm, and a check
 * that cries wolf is one nobody reads - which is how a mutation would
 * eventually get committed. So the content read before each mutation is kept
 * and compared against the content on disk at the end.
 */
const dirty = [...before.entries()]
  .filter(([file, content]) => readFileSync(file, 'utf8') !== content)
  .map(([file]) => `M ${file}`)
  .join('\n');

console.log('\n--- mutation results ---------------------------------------------\n');
let survived = 0;
for (const result of results) {
  const flag =
    result.status === 'CAUGHT' ? ' ' : result.status === 'SURVIVED' ? '!' : '?';
  if (result.status === 'SURVIVED' && !result.expectSurvive) survived += 1;
  console.log(`${flag} ${result.status.padEnd(11)} ${result.id.padEnd(26)} ${result.what}`);
  if (result.note) console.log(`               note: ${result.note}`);
}

console.log(
  `\n${results.filter((r) => r.status === 'CAUGHT').length} caught, ` +
    `${results.filter((r) => r.status === 'SURVIVED').length} survived, ` +
    `${results.filter((r) => r.status === 'NOT APPLIED').length} not applied`,
);

if (dirty !== '') {
  console.log(`\nWARNING: the working tree is not clean after restoring:\n${dirty}`);
  process.exit(2);
}
console.log('working tree restored clean');

process.exit(survived === 0 ? 0 : 1);
