/**
 * Phase 4 — the central provider-safety decision, tested purely.
 *
 * The one rule: production NEVER silently selects a mock. Every mock-capable
 * capability (commerce, identity, email, sms) is MOCK in development/test, REAL
 * when real config is present, and UNAVAILABLE (fail closed) in production without
 * real config. These are pure functions over an explicit AppEnv, so they run
 * without a process environment and without tripping the production boot guard.
 */
import { describe, expect, it } from 'vitest';
import type { AppEnv } from './env.js';
import {
  commerceConfigured,
  commerceMode,
  emailConfigured,
  emailMode,
  identityConfigured,
  identityMode,
  providerSafetySummary,
  resolveProviderMode,
  smsConfigured,
  smsMode,
} from './provider-safety.js';
import { commerceProviderFromEnv } from '../platform/commerce-provider.js';
import { identityProviderFromEnv } from '../platform/identity-providers.js';
import { emailProviderFromEnv } from '../platform/notification-providers.js';

const base: AppEnv = {
  NODE_ENV: 'development',
  PORT: 4000,
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgres://atlas:atlas@localhost:5432/atlas',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-real-private-secret-of-enough-length',
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
  MARKET_DATA_PROVIDER: 'yahoo-delayed',
  MARKET_DATA_POLL_MS: 5_000,
  MARKET_DATA_STALE_MS: 120_000,
  MARKET_DATA_DELAY_SECONDS: 600,
  DATABENTO_DATASET: 'GLBX.MDP3',
  MARKET_DATA_REDISTRIBUTION: 'none',
  EXECUTION_PROVIDER: 'simulation',
  EXTERNAL_LIVE_ENABLED: false,
  RITHMIC_ENABLED: false,
  RITHMIC_ENVIRONMENT: 'TEST',
  RITHMIC_MARKET_DATA_ENABLED: false,
  RITHMIC_EXECUTION_ENABLED: false,
  FILL_MODEL: 'ADVANCED',
  FILL_LATENCY_MS: 120,
  FILL_SLIPPAGE_TICKS: 0,
  RATE_LIMIT_ORDERS_PER_MINUTE: 120,
  CORS_ORIGIN: '*',
  REPLAY_DIR: './data/recordings',
  TRUSTED_PROXY: 'false',
  WHOP_SANDBOX: false,
  HTF_AUTO_FUNDING: true,
  OBJECT_STORE_PROVIDER: 'local',
  ARTIFACT_STORE_DIR: '.artifacts',
  PRODIGI_ENV: 'sandbox',
  PRODIGI_ENABLED: false,
  MERCH_ENABLED: false,
};

const dev = base;
const test = { ...base, NODE_ENV: 'test' as const };
const prod = { ...base, NODE_ENV: 'production' as const, CORS_ORIGIN: 'https://atlas.example' };
const prodConfigured: AppEnv = {
  ...prod,
  WHOP_WEBHOOK_SECRET: 'whsec_real',
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_IDENTITY_WEBHOOK_SECRET: 'whsec_stripe',
  RESEND_API_KEY: 're_x',
  RESEND_FROM: 'no-reply@atlas.example',
  TWILIO_ACCOUNT_SID: 'AC_x',
  TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_FROM: '+15550001111',
};

describe('resolveProviderMode — the one rule', () => {
  it('REAL whenever real config is present, in any environment', () => {
    expect(resolveProviderMode(true, 'development')).toBe('REAL');
    expect(resolveProviderMode(true, 'test')).toBe('REAL');
    expect(resolveProviderMode(true, 'production')).toBe('REAL');
  });
  it('MOCK when unconfigured in development/test', () => {
    expect(resolveProviderMode(false, 'development')).toBe('MOCK');
    expect(resolveProviderMode(false, 'test')).toBe('MOCK');
  });
  it('UNAVAILABLE (never MOCK) when unconfigured in production', () => {
    expect(resolveProviderMode(false, 'production')).toBe('UNAVAILABLE');
  });
});

describe('per-capability modes — unconfigured', () => {
  for (const [label, c] of [['development', dev], ['test', test]] as const) {
    it(`${label}: commerce/identity/email/sms all MOCK`, () => {
      expect(commerceMode(c)).toBe('MOCK');
      expect(identityMode(c)).toBe('MOCK');
      expect(emailMode(c)).toBe('MOCK');
      expect(smsMode(c)).toBe('MOCK');
    });
  }
  it('production: commerce/identity/email/sms all UNAVAILABLE (fail closed)', () => {
    expect(commerceMode(prod)).toBe('UNAVAILABLE');
    expect(identityMode(prod)).toBe('UNAVAILABLE');
    expect(emailMode(prod)).toBe('UNAVAILABLE');
    expect(smsMode(prod)).toBe('UNAVAILABLE');
  });
});

describe('per-capability modes — configured', () => {
  it('production with real config → REAL', () => {
    expect(commerceMode(prodConfigured)).toBe('REAL');
    expect(identityMode(prodConfigured)).toBe('REAL');
    expect(emailMode(prodConfigured)).toBe('REAL');
    expect(smsMode(prodConfigured)).toBe('REAL');
  });
});

describe('configured predicates mirror the providers', () => {
  it('commerce needs the Whop webhook secret', () => {
    expect(commerceConfigured(prod)).toBe(false);
    expect(commerceConfigured({ ...prod, WHOP_WEBHOOK_SECRET: 'whsec' })).toBe(true);
  });
  it('identity needs BOTH Stripe secrets', () => {
    expect(identityConfigured({ ...prod, STRIPE_SECRET_KEY: 'sk' })).toBe(false);
    expect(identityConfigured({ ...prod, STRIPE_SECRET_KEY: 'sk', STRIPE_IDENTITY_WEBHOOK_SECRET: 'wh' })).toBe(true);
  });
  it('email needs key + from; sms needs sid + token + from', () => {
    expect(emailConfigured({ ...prod, RESEND_API_KEY: 're' })).toBe(false);
    expect(emailConfigured({ ...prod, RESEND_API_KEY: 're', RESEND_FROM: 'a@b.c' })).toBe(true);
    expect(smsConfigured({ ...prod, TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' })).toBe(false);
    expect(smsConfigured({ ...prod, TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1' })).toBe(true);
  });
});

describe('providerSafetySummary — owner never sees a mock as healthy in production', () => {
  it('development: mock-capable report MOCK and are safe (development)', () => {
    const s = new Map(providerSafetySummary(dev).map((x) => [x.capability, x]));
    expect(s.get('COMMERCE')!.mode).toBe('MOCK');
    expect(s.get('IDENTITY')!.mode).toBe('MOCK');
    expect(s.get('EMAIL')!.mode).toBe('MOCK');
    // a development mock is safe *for development*, and never reported as production healthy
    expect(s.get('COMMERCE')!.safeForProduction).toBe(true);
    expect(s.get('COMMERCE')!.detail).toMatch(/mock/i);
  });
  it('production unconfigured: mock-capable report UNAVAILABLE (unhealthy/absent), never MOCK', () => {
    for (const s of providerSafetySummary(prod)) {
      expect(s.mode).not.toBe('MOCK');
    }
    const s = new Map(providerSafetySummary(prod).map((x) => [x.capability, x]));
    expect(s.get('COMMERCE')!.mode).toBe('UNAVAILABLE');
    expect(s.get('IDENTITY')!.mode).toBe('UNAVAILABLE');
  });
  it('payouts/market-data/execution are always safe classifications', () => {
    const s = new Map(providerSafetySummary(prod).map((x) => [x.capability, x]));
    expect(s.get('PAYOUTS')!.safeForProduction).toBe(true);
    expect(s.get('MARKET_DATA')!.mode).toBe('DELIBERATE');
    expect(s.get('EXECUTION')!.mode).toBe('DELIBERATE');
  });
});

describe('factories in the test runtime use the deterministic mocks (dev/test only)', () => {
  // The vitest runtime is NODE_ENV=test, so unconfigured capabilities resolve to MOCK.
  it('commerce/identity/email select the mock and it is explicitly configured', () => {
    expect(commerceProviderFromEnv().name).toBe('MOCK');
    expect(identityProviderFromEnv().name).toBe('MOCK');
    const email = emailProviderFromEnv();
    expect(email.name).toBe('MOCK');
  });
});
