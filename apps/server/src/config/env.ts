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

  /**
   * Whether to trust the `X-Forwarded-For` chain for the client IP.
   *
   * DEFAULT FALSE — do NOT trust the header. Fastify's `trustProxy` makes
   * `request.ip` come from `X-Forwarded-For`, which any direct client can set
   * to anything. With it on and no real proxy in front, an attacker rotates a
   * spoofed IP per request and every IP-keyed rate limit (and any IP we log)
   * is defeated. Turn this on ONLY when Atlas genuinely sits behind a trusted
   * reverse proxy/load balancer that overwrites the header. Accepts `true`/
   * `false`, or a comma-separated list of trusted proxy IPs/CIDRs.
   */
  TRUSTED_PROXY: z.string().default('false'),

  /**
   * Whop payment integration. SERVER-SIDE ONLY, and optional by design.
   *
   * The whole commercial lifecycle compiles, tests and runs without any of
   * these: the payment provider is a TRIGGER into the domain, not part of it.
   * The webhook secret is what turns real fulfilment on - absent, the webhook
   * route refuses every request rather than processing an unsigned one, and no
   * money path exists. The secret is never logged, never returned from an API,
   * never sent to the browser. Atlas performs NO charge itself: card data lives
   * entirely on Whop's hosted/embedded surface. See
   * docs/commercial-account-lifecycle-v1-report.md.
   */
  WHOP_WEBHOOK_SECRET: z.string().optional(),
  /**
   * SANDBOX ONLY in this milestone. The company API key (apik_...) and company
   * id (biz_...) from a Whop SANDBOX account, used server-side to create the
   * checkout session the embedded component renders. There is no production Whop
   * host in this build: the client targets sandbox-api.whop.com and nothing
   * else, so no real charge is reachable.
   */
  WHOP_COMPANY_API_KEY: z.string().optional(),
  WHOP_COMPANY_ID: z.string().optional(),
  /**
   * Must be `true` to enable checkout-session creation. A hard gate against
   * accidentally driving real money: with it unset or false, the checkout
   * reports not-configured and no session is created.
   */
  WHOP_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Where Whop returns the buyer after the embedded checkout completes. */
  WHOP_CHECKOUT_RETURN_URL: z.string().optional(),

  /**
   * Identity verification (Stripe Identity). OPTIONAL and NOT wired in this
   * milestone. With these unset the identity provider is the deterministic MOCK;
   * the Stripe adapter exists only as a seam that reports itself unconfigured and
   * NEVER fabricates a verified result. The mock being active is not evidence a
   * real KYC verification occurred.
   */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_IDENTITY_WEBHOOK_SECRET: z.string().optional(),

  /**
   * Notification providers (Resend email, Twilio SMS). OPTIONAL and NOT wired in
   * this milestone. Unset → the deterministic MOCK providers record what would
   * have been sent; the real adapters are seams that report unconfigured and mark
   * a message SUPPRESSED rather than faking a delivery. Trading/payment/
   * provisioning never wait on any of these.
   */
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
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

/**
 * Fastify's `trustProxy` value, derived from `TRUSTED_PROXY`.
 *
 * `false` (the default) → do not trust `X-Forwarded-For`; `request.ip` is the
 * real socket peer, so a spoofed header cannot forge the rate-limit key.
 * `true` → trust the whole chain. Anything else is treated as a comma-separated
 * list of trusted proxy IPs/CIDRs and forwarded to Fastify (`proxy-addr`), so
 * only a forwarded header arriving from a named proxy is believed.
 */
export function trustProxyOption(): boolean | string[] {
  const raw = env().TRUSTED_PROXY.trim();
  if (raw === '' || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
