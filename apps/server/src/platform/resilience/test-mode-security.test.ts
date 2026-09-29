/**
 * Engineering Resilience Phase 2 — Part XLIX: prove the test-mode scrypt work
 * factor cannot leak into production.
 *
 * Phase 1 lowered the scrypt cost under the test runner to fix a flake. This
 * proves MECHANICALLY that the reduction is isolated: the selection is a pure
 * function of the environment, and only an unambiguous test runner
 * (VITEST==='true' or NODE_ENV==='test') gets the weak factor. Production and the
 * bare default get the strong factor.
 */
import { describe, expect, it } from 'vitest';
import { selectScryptParams, PROD_SCRYPT_PARAMS, TEST_SCRYPT_PARAMS } from '../../auth/password.js';

describe('Part XLIX — test-mode scrypt work factor is mechanically isolated', () => {
  it('production selects the strong factor', () => {
    expect(selectScryptParams({ NODE_ENV: 'production' })).toBe(PROD_SCRYPT_PARAMS);
    expect(selectScryptParams({ NODE_ENV: 'production' }).N).toBe(32768);
  });

  it('the bare default (no env) selects the strong factor — never test', () => {
    expect(selectScryptParams({})).toBe(PROD_SCRYPT_PARAMS);
    // Even a production deploy that forgot to set NODE_ENV stays strong.
    expect(selectScryptParams({ NODE_ENV: 'staging' })).toBe(PROD_SCRYPT_PARAMS);
    expect(selectScryptParams({ VITEST: 'false' })).toBe(PROD_SCRYPT_PARAMS);
    expect(selectScryptParams({ VITEST: '1' })).toBe(PROD_SCRYPT_PARAMS); // strict '===true' only
  });

  it('only an unambiguous test runner selects the weak factor', () => {
    expect(selectScryptParams({ VITEST: 'true' })).toBe(TEST_SCRYPT_PARAMS);
    expect(selectScryptParams({ NODE_ENV: 'test' })).toBe(TEST_SCRYPT_PARAMS);
    expect(selectScryptParams({ VITEST: 'true' }).N).toBe(1024);
  });

  it('production strength is not weaker than OWASP-class guidance (N ≥ 2^15)', () => {
    expect(PROD_SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(32768);
    // A production factor must never accidentally equal the test factor.
    expect(PROD_SCRYPT_PARAMS.N).not.toBe(TEST_SCRYPT_PARAMS.N);
  });

  it('the algorithm/format is identical (only N differs) so a cross-cost hash verifies', () => {
    expect(PROD_SCRYPT_PARAMS.r).toBe(TEST_SCRYPT_PARAMS.r);
    expect(PROD_SCRYPT_PARAMS.p).toBe(TEST_SCRYPT_PARAMS.p);
  });
});
