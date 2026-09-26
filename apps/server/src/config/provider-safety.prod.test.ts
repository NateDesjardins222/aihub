/**
 * Phase 4 — provider factories under a REAL production runtime (fail-closed proof).
 *
 * This file boots the process env as production with valid JWT/CORS (so the
 * production config guard passes) and asserts that with NO provider credentials
 * the factories select the fail-closed real seams — NEVER a mock. It is a separate
 * file because `env()` caches once per module context; here that cache is
 * production for every test.
 */
process.env['NODE_ENV'] = 'production';
process.env['JWT_SECRET'] = 'a-real-private-secret-of-enough-length';
process.env['CORS_ORIGIN'] = 'https://atlas.example';
// Ensure no provider is configured, so every capability must fail closed.
delete process.env['WHOP_WEBHOOK_SECRET'];
delete process.env['STRIPE_SECRET_KEY'];
delete process.env['STRIPE_IDENTITY_WEBHOOK_SECRET'];
delete process.env['RESEND_API_KEY'];
delete process.env['TWILIO_AUTH_TOKEN'];

import { describe, expect, it } from 'vitest';
import {
  activeCommerceProviderName,
  commerceProviderFromEnv,
} from '../platform/commerce-provider.js';
import { simulateProviderPayment } from '../platform/commerce-fulfillment.js';
import {
  activeIdentityProviderName,
  identityProviderFromEnv,
} from '../platform/identity-providers.js';
import {
  activeEmailProviderName,
  activeSmsProviderName,
  emailProviderFromEnv,
  smsProviderFromEnv,
} from '../platform/notification-providers.js';
import { resolvePayoutProvider } from '../platform/payout-provider-registry.js';
import { isProduction } from './env.js';

describe('production runtime with no provider config', () => {
  it('is actually running as production', () => {
    expect(isProduction()).toBe(true);
  });

  it('COMMERCE: never the mock; the seam reports unconfigured (fail closed)', () => {
    const p = commerceProviderFromEnv();
    expect(p.name).toBe('WHOP');
    expect(p.isConfigured()).toBe(false); // the webhook route 503s on this
    expect(activeCommerceProviderName()).toBe('unavailable');
  });

  it('COMMERCE: a direct mock payment simulation is REJECTED', async () => {
    await expect(
      simulateProviderPayment({} as never, { organizationId: 'o', orderId: 'x' }),
    ).rejects.toMatchObject({ code: 'MOCK_COMMERCE_FORBIDDEN' });
  });

  it('IDENTITY: never the mock; the Stripe seam refuses (no fabricated VERIFIED)', async () => {
    const p = identityProviderFromEnv();
    expect(p.name).toBe('STRIPE');
    expect(activeIdentityProviderName()).toBe('unavailable');
    // A customer-driven verification cannot fabricate a VERIFIED result: the seam throws.
    await expect(
      p.createVerification({ identityId: 'id', legalName: 'Jane Trader' }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('NOTIFICATIONS: never the faking mock; the seam SUPPRESSES (ok:false)', async () => {
    const email = emailProviderFromEnv();
    const sms = smsProviderFromEnv();
    expect(email.name).toBe('RESEND');
    expect(sms.name).toBe('TWILIO');
    expect(activeEmailProviderName()).toBe('suppressed');
    expect(activeSmsProviderName()).toBe('suppressed');
    await expect(email.send({ to: 'a@b.c', subject: 's', body: 'b' })).resolves.toMatchObject({ ok: false });
    await expect(sms.send({ to: '+1', body: 'b' })).resolves.toMatchObject({ ok: false });
  });

  it('PAYOUT: a mock provider is never resolvable in production (fail closed)', () => {
    const p = resolvePayoutProvider('MOCK');
    expect(p.isMock).not.toBe(true);
    // an unknown/absent provider also fails closed
    expect(resolvePayoutProvider(null).isMock).not.toBe(true);
  });
});
