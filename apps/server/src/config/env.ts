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

  /** Market data provider selection. */
  MARKET_DATA_PROVIDER: z.enum(['yahoo-delayed', 'replay']).default('yahoo-delayed'),
  MARKET_DATA_POLL_MS: z.coerce.number().int().default(5_000),
  /**
   * Quotes older than this are stale: order entry is disabled and the UI is told.
   * Generous by default because the Phase 1 feed is delayed by design.
   */
  MARKET_DATA_STALE_MS: z.coerce.number().int().default(120_000),
  /** Declared delay of the Phase 1 feed, surfaced in the UI. Never reported as realtime. */
  MARKET_DATA_DELAY_SECONDS: z.coerce.number().int().default(600),

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

export function env(): AppEnv {
  if (!cached) cached = envSchema.parse(process.env);
  return cached;
}

export function isProduction(): boolean {
  return env().NODE_ENV === 'production';
}
