/**
 * Phase 4 — the development seed must HARD-FAIL in production (test 18).
 */
import { describe, expect, it } from 'vitest';
import { assertDevSeedAllowed, DevSeedForbiddenError } from './seed-guard.js';

describe('assertDevSeedAllowed', () => {
  it('throws in production (no silent skip)', () => {
    expect(() => assertDevSeedAllowed('production')).toThrow(DevSeedForbiddenError);
    expect(() => assertDevSeedAllowed('production')).toThrow(/refusing to run the development seed/i);
  });
  it('allows development and test', () => {
    expect(() => assertDevSeedAllowed('development')).not.toThrow();
    expect(() => assertDevSeedAllowed('test')).not.toThrow();
    expect(() => assertDevSeedAllowed(undefined)).not.toThrow();
  });
});
