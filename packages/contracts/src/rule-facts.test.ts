/**
 * Rule-copy parity (HTF-31).
 *
 * Every numeric fact shown in a family's rule bullets must be DERIVED from the
 * family's structured numeric config — never hand-typed — so a change to the
 * config cannot leave stale prose behind. These tests fail if anyone reintroduces
 * a literal that disagrees with the config.
 */
import { describe, expect, it } from 'vitest';
import {
  FAMILIES,
  familyRuleBullets,
  REQUIRED_WINNING_DAYS,
  WINNING_DAY_THRESHOLD_USD,
} from './product-catalog.js';

describe('family rule bullets derive from the numeric config', () => {
  for (const f of FAMILIES) {
    describe(f.name, () => {
      const bullets = f.rules;

      it('is exactly the derivation (no hand-authored override)', () => {
        expect(f.rules).toEqual(familyRuleBullets(f));
      });

      it('states the evaluation consistency percentage from config', () => {
        expect(bullets).toContain(`${f.evalConsistencyPct}% evaluation consistency`);
      });

      it('states the funded consistency exactly as configured', () => {
        if (f.fundedConsistencyPct === null) {
          expect(bullets).toContain('No funded consistency rule');
          expect(bullets.join(' ')).not.toContain('funded / payout consistency');
        } else {
          expect(bullets).toContain(`${f.fundedConsistencyPct}% funded / payout consistency`);
        }
      });

      it('states the profit split from config', () => {
        expect(bullets).toContain(`${f.splitPct}% trader profit split`);
      });

      it('states the activation fee from config', () => {
        expect(bullets).toContain(`$${f.activationFeeUsd} activation fee`);
      });

      it('states the winning-day requirement from the shared constants', () => {
        expect(bullets).toContain(
          `${REQUIRED_WINNING_DAYS} winning days of $${WINNING_DAY_THRESHOLD_USD} or more`,
        );
      });

      it('always discloses no daily loss limit (a V1 invariant)', () => {
        expect(bullets).toContain('No daily loss limit');
      });

      it('contains no consistency percentage that disagrees with config', () => {
        // Any "NN% ... consistency" bullet must use one of the configured values.
        const allowed = new Set(
          [f.evalConsistencyPct, f.fundedConsistencyPct].filter((n): n is number => n !== null),
        );
        for (const b of bullets) {
          const m = b.match(/(\d+)%.*consistency/i);
          if (m) expect(allowed).toContain(Number(m[1]));
        }
      });
    });
  }
});
