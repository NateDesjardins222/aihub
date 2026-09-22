# Atlas — production environment reference

Every runtime configuration variable, its purpose, default, sensitivity, and
what production requires. **No real values appear here** — this is a schema and a
checklist, not a secrets store. Secrets are supplied out of band (a secret
manager / the deployment platform's encrypted env), never committed, never
printed. The source of truth is `apps/server/src/config/env.ts`.

## Legend

- **Sensitivity** — `secret` (never log, never return, never commit), `config`
  (non-secret operational value), `public` (safe to expose).
- **Prod** — what production requires beyond the development default.

## Core

| Variable | Default | Sensitivity | Prod requirement |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | config | `production` — enables HSTS, info-level logging, and the boot-time config guard |
| `PORT` | `4000` | config | as needed |
| `HOST` | `0.0.0.0` | config | as needed |
| `DATABASE_URL` | local dev DSN | **secret** | a private PostgreSQL DSN; the only source of financial truth |
| `REDIS_URL` | local dev DSN | config | as needed |

## Authentication & sessions

| Variable | Default | Sensitivity | Prod requirement |
| --- | --- | --- | --- |
| `JWT_SECRET` | built-in dev default | **secret** | **MUST** be a private 32+ byte secret. Production refuses to boot on the built-in default (exit 78). Rotating it invalidates all live access tokens (refresh tokens are DB-backed and survive). |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` (15 min) | config | short by design; also the F-06 revocation window for requireUser-only routes |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` (30 d) | config | as desired |

## Network / edge hardening

| Variable | Default | Sensitivity | Prod requirement |
| --- | --- | --- | --- |
| `CORS_ORIGIN` | `*` | config | **MUST** be the terminal's own origin(s), comma-separated. Production refuses to boot on `*` (exit 78). |
| `TRUSTED_PROXY` | `false` | config | Leave `false` unless Atlas sits behind a trusted reverse proxy/LB that overwrites `X-Forwarded-For`; then set `true` or a comma-separated list of proxy IPs/CIDRs. Trusting it wrongly lets clients spoof their IP and defeat rate limits (F-02). |
| `RATE_LIMIT_ORDERS_PER_MINUTE` | `120` | config | tune to expected order flow |

## Market data (Databento **PAUSED** this milestone)

| Variable | Default | Sensitivity | Prod requirement |
| --- | --- | --- | --- |
| `MARKET_DATA_PROVIDER` | `yahoo-delayed` | config | deliberate choice; `databento` requires a real entitlement and is NOT enabled here |
| `MARKET_DATA_POLL_MS` | `5000` | config | — |
| `MARKET_DATA_STALE_MS` | `120000` | config | — |
| `MARKET_DATA_DELAY_SECONDS` | `600` | config | surfaced in the UI; never reported as realtime |
| `DATABENTO_API_KEY` | (unset) | **secret** | **NOT set / not used this milestone.** Server-side only if ever enabled; never sent to the browser |
| `DATABENTO_DATASET` | `GLBX.MDP3` | config | — |
| `MARKET_DATA_REDISTRIBUTION` | `none` | config | compliance statement; must be backed by a real entitlement to raise |

## Fill simulation

| Variable | Default | Sensitivity |
| --- | --- | --- |
| `FILL_MODEL` | `ADVANCED` | config |
| `FILL_LATENCY_MS` | `120` | config |
| `FILL_SLIPPAGE_TICKS` | `0` | config |
| `REPLAY_DIR` | `./data/recordings` | config |

## Payments (Whop — **PAUSED**, sandbox/offline only)

The entire commercial lifecycle compiles, tests, and runs without any of these.
The webhook route refuses every request while `WHOP_WEBHOOK_SECRET` is unset, so
no money path exists. **None are set or used this milestone.**

| Variable | Default | Sensitivity | Notes |
| --- | --- | --- | --- |
| `WHOP_WEBHOOK_SECRET` | (unset) | **secret** | turns fulfilment on; absent → webhook refuses all. Never logged/returned |
| `WHOP_COMPANY_API_KEY` | (unset) | **secret** | sandbox company key; server-side only |
| `WHOP_COMPANY_ID` | (unset) | config | sandbox company id |
| `WHOP_SANDBOX` | `false` | config | must be `true` to create a checkout session; a hard gate against real money |
| `WHOP_CHECKOUT_RETURN_URL` | (unset) | config | buyer return URL |

## Build-time (web)

| Variable | Default | Sensitivity | Notes |
| --- | --- | --- | --- |
| `WEB_SOURCEMAP` | `false` | config | leave off in production so the build ships no source maps (F-05); set `true` only to profile a built bundle |

## Secret inventory (what must never leak)

`DATABASE_URL`, `JWT_SECRET`, `DATABENTO_API_KEY`, `WHOP_WEBHOOK_SECRET`,
`WHOP_COMPANY_API_KEY`. Handling verified this milestone:

- **Not committed** — `.env`/`.env.local` are git-ignored; no secret file is
  tracked (verified with `git ls-files`).
- **Not returned** — no API response includes a secret or a password hash
  (verified; `security.test.ts` asserts registration returns no `passwordHash`).
- **Not logged** — the logger redacts `req.headers.authorization`,
  `req.body.password`, `req.body.refreshToken`; secrets are never passed to the
  logger.
- **Boot-time guard** — production refuses to start on the built-in `JWT_SECRET`
  or a `*` `CORS_ORIGIN` (`env.ts` `guardProduction`, exit 78; tested).

## Production preflight checklist

1. `NODE_ENV=production`.
2. `JWT_SECRET` set to a private 32+ byte random value (NOT the dev default).
3. `CORS_ORIGIN` set to the exact terminal origin(s), not `*`.
4. `DATABASE_URL` points at the production PostgreSQL with backups configured
   (see `production-backup-restore-requirements.md`).
5. `TRUSTED_PROXY` set only if a real trusted proxy terminates TLS in front.
6. `WEB_SOURCEMAP` unset/false for the deployed web build.
7. Secrets delivered via the platform's encrypted store, never a committed file.
8. Whop and Databento remain unset (paused) until their milestones are resumed.
