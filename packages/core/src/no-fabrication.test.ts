import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A standing guard against fabricated market data.
 *
 * The single hard rule of this platform is that no price is ever invented. This
 * test walks every file that can influence a price, a bar, a quote or a fill and
 * fails the build if it finds a random number generator.
 *
 * Randomness is legitimate in exactly one place — jitter on WebSocket reconnect
 * backoff, so that a server restart does not produce a synchronised stampede
 * from every open tab. That file is named explicitly below; anything else must
 * be justified by adding it here deliberately, which makes the exception
 * reviewable rather than accidental.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** Directories whose contents can affect market data or trading outcomes. */
const GUARDED_DIRS = [
  'packages/core/src',
  'packages/instruments/src',
  'packages/contracts/src',
  'apps/server/src/marketdata',
  'apps/server/src/ws',
  'apps/web/src/chart',
  'apps/web/src/panels',
];

/** Files permitted to use randomness, with the reason. */
const ALLOWED: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'apps/web/src/market/stream.ts',
    reason: 'reconnect backoff jitter — affects timing, never a price',
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no fabricated market data', () => {
  const files = GUARDED_DIRS.flatMap((dir) => walk(join(REPO_ROOT, dir)));

  it('guards a non-trivial number of files', () => {
    // Guards against the walk silently finding nothing and passing vacuously.
    expect(files.length).toBeGreaterThan(15);
  });

  it('contains no random number generation in any price-bearing path', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const relative = file.slice(REPO_ROOT.length + 1);
      if (relative.endsWith('no-fabrication.test.ts')) continue;
      if (ALLOWED.some((a) => relative === a.path)) continue;

      const source = readFileSync(file, 'utf8');
      // Strip this guard's own vocabulary from comments so a file that merely
      // *documents* the rule is not reported as breaking it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      if (/Math\s*\.\s*random/.test(code)) offenders.push(`${relative}: Math.random`);
      if (/crypto\s*\.\s*getRandomValues/.test(code)) {
        offenders.push(`${relative}: crypto.getRandomValues`);
      }
    }

    expect(offenders, `randomness found in price-bearing code:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('documents every permitted exception', () => {
    for (const allowed of ALLOWED) {
      expect(allowed.reason.length).toBeGreaterThan(10);
    }
  });
});
