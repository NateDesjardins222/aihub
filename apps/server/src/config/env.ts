/** Central configuration. Every tunable the engine depends on lives here. */
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().default('postgres://atlas:atlas@localhost:5432/atlas'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  /** HS256 signing secret. Must be overridden outside development. */
  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().default(30 * 24 * 3600),

  /**
   * Market data provider selection — DELIBERATE, never inferred.
   *
   * A present DATABENTO_API_KEY does NOT switch the provider on its own: this
   * value chooses it. That keeps "the key exists" (a transport fact) separate
   * from "use the professional feed" (an operator decision). See
   * docs/market-data-licensing-gate.md.
   */
  MARKET_DATA_PROVIDER: z.enum(['yahoo-delayed', 'replay', 'databento']).default('yahoo-delayed'),
  MARKET_DATA_POLL_MS: z.coerce.number().int().default(5_000),
  /**
   * Quotes older than this are stale: order entry is disabled and the UI is told.
   * Generous by default because the Phase 1 feed is delayed by design.
   */
  MARKET_DATA_STALE_MS: z.coerce.number().int().default(120_000),
  /** Declared delay of the Phase 1 feed, surfaced in the UI. Never reported as realtime. */
  MARKET_DATA_DELAY_SECONDS: z.coerce.number().int().default(600),

  /**
   * Databento credentials and dataset. SERVER-SIDE ONLY.
   *
   * The key is never logged, never returned from an API, never sent to the
   * browser. It is optional so the whole provider-neutral core and the adapter
   * build and test without it; only the first authenticated live/historical
   * call requires it. GLBX.MDP3 is CME Globex MDP 3.0 (all eight Atlas roots).
   */
  DATABENTO_API_KEY: z.string().optional(),
  DATABENTO_DATASET: z.string().default('GLBX.MDP3'),
  /**
   * Declared redistribution posture — a compliance statement, not a capability.
   * Atlas ships `none`; anything above must be backed by a real entitlement.
   * Surfaced in Owner System Health. See docs/market-data-licensing-gate.md.
   */
  MARKET_DATA_REDISTRIBUTION: z
    .enum(['none', 'internal', 'delayed-external', 'realtime-external'])
    .default('none'),

  /** Simulation fill model. */
  FILL_MODEL: z.enum(['SIMPLE', 'ADVANCED']).default('ADVANCED'),
  FILL_LATENCY_MS: z.coerce.number().int().default(120),
  FILL_SLIPPAGE_TICKS: z.coerce.number().int().default(0),

  RATE_LIMIT_ORDERS_PER_MINUTE: z.coerce.number().int().default(120),
  CORS_ORIGIN: z.string().default('*'),
  REPLAY_DIR: z.string().default('./data/recordings'),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

const INSECURE_JWT_DEFAULT = 'dev-only-insecure-secret-change-me';

export function env(): AppEnv {
  if (!cached) {
    cached = envSchema.parse(process.env);
    guardProduction(cached);
  }
  return cached;
}

/**
 * Things that are convenient in development and catastrophic in production.
 *
 * The schema gives JWT_SECRET a working default so a developer can clone and
 * run - but that default is PUBLIC, it is in this file, and a server that signs
 * real sessions with it can have its tokens forged by anyone who has read the
 * source. Same for a wide-open CORS origin. A default that is safe only because
 * nobody deployed it is a P0 waiting for the first deploy, so production refuses
 * to boot on either rather than running quietly insecure.
 *
 * This is a fail-fast, not a policy engine: it names the variable and the fix
 * and exits, because a misconfigured auth secret is not something to page
 * someone about at runtime - it is something to catch before the process
 * listens.
 */
function guardProduction(config: AppEnv): void {
  const problem = productionMisconfiguration(config);
  if (problem === null) return;
  // Not a thrown ApiError: nothing is serving yet, and the operator needs to
  // see exactly this line in the boot log.
  console.error(`FATAL: ${problem}`);
  process.exit(78); // EX_CONFIG, the conventional "the configuration is wrong" code.
}

/**
 * The one refusal reason, or null. Pure, so it can be tested without exiting.
 */
export function productionMisconfiguration(config: AppEnv): string | null {
  if (config.NODE_ENV !== 'production') return null;
  if (config.JWT_SECRET === INSECURE_JWT_DEFAULT) {
    return 'JWT_SECRET is the built-in development default in production. Set JWT_SECRET to a private 32+ byte secret.';
  }
  if (config.CORS_ORIGIN === '*') {
    return 'CORS_ORIGIN is "*" in production. Set it to the terminal\'s own origin.';
  }
  return null;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}
