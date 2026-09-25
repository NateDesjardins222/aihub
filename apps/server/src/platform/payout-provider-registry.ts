/**
 * The payout-provider registry (Milestone 8).
 *
 * Resolves a provider id to a concrete `PayoutProvider`, enforcing the two
 * non-negotiable safety rules:
 *  - a MOCK provider may only run in non-production modes; in production it is
 *    never resolvable, so a production payout can never silently run on the mock.
 *  - an unconfigured production provider resolves to `UnconfiguredPayoutProvider`,
 *    which fails closed (refuses to move money) rather than defaulting to a mock.
 */
import { env } from '../config/env.js';
import { MockPayoutProvider } from './payout-provider-mock.js';
import { UnconfiguredPayoutProvider, type PayoutProvider } from './payout-provider.js';

/** The process-wide mock instance so tests can `program` it and the app share it. */
let mockSingleton: MockPayoutProvider | null = null;
export function mockPayoutProvider(): MockPayoutProvider {
  if (!mockSingleton) mockSingleton = new MockPayoutProvider();
  return mockSingleton;
}

/** For tests: reset the shared mock between suites. */
export function resetMockPayoutProvider(): void {
  mockSingleton?.reset();
}

const unconfigured = new UnconfiguredPayoutProvider();

export function isProduction(): boolean {
  try {
    return env().NODE_ENV === 'production';
  } catch {
    return false;
  }
}

/**
 * Resolve a provider by its configured id. A null/absent id, or any unknown id,
 * resolves to the unconfigured (fail-closed) provider. The mock is only ever
 * returned outside production.
 */
export function resolvePayoutProvider(providerId: string | null | undefined): PayoutProvider {
  if (!providerId) return unconfigured;
  const id = providerId.toUpperCase();
  if (id === 'MOCK') {
    if (isProduction()) return unconfigured; // never run the mock in production
    return mockPayoutProvider();
  }
  // Real providers (ACH/bank/etc.) plug in here once credentials/contracts exist.
  // Until then any named-but-unimplemented provider fails closed.
  return unconfigured;
}
