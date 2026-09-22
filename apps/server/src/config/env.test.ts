/**
 * The production configuration guard.
 *
 * The schema gives JWT_SECRET and CORS_ORIGIN working defaults so the project
 * clones and runs. Those defaults are public, and a server that signs real
 * sessions with the built-in secret can have its tokens forged by anyone who
 * has read this repository. Production must refuse to boot on them. See D-016.
 */
import { describe, expect, it } from 'vitest';
import { productionMisconfiguration, type AppEnv } from './env.js';

const base: AppEnv = {
  NODE_ENV: 'production',
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
  FILL_MODEL: 'ADVANCED',
  FILL_LATENCY_MS: 120,
  FILL_SLIPPAGE_TICKS: 0,
  RATE_LIMIT_ORDERS_PER_MINUTE: 120,
  CORS_ORIGIN: 'https://atlas.example',
  REPLAY_DIR: './data/recordings',
  WHOP_SANDBOX: false,
};

describe('the production configuration guard', () => {
  it('refuses the built-in JWT secret in production', () => {
    const problem = productionMisconfiguration({
      ...base,
      JWT_SECRET: 'dev-only-insecure-secret-change-me',
    });
    expect(problem).toMatch(/JWT_SECRET/);
  });

  it('refuses a wide-open CORS origin in production', () => {
    expect(productionMisconfiguration({ ...base, CORS_ORIGIN: '*' })).toMatch(/CORS_ORIGIN/);
  });

  it('permits a properly configured production server', () => {
    expect(productionMisconfiguration(base)).toBeNull();
  });

  it('leaves development alone, defaults and all', () => {
    expect(
      productionMisconfiguration({
        ...base,
        NODE_ENV: 'development',
        JWT_SECRET: 'dev-only-insecure-secret-change-me',
        CORS_ORIGIN: '*',
      }),
    ).toBeNull();
  });
});
