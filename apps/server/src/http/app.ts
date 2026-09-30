/** Fastify application assembly. */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env, isProduction, trustProxyOption } from '../config/env.js';
import { ApiError } from './errors.js';
import { registerAuth } from './auth-plugin.js';
import { authRoutes } from './routes/auth.js';
import { instrumentRoutes } from './routes/instruments.js';
import { accountRoutes, ruleTemplateRoutes } from './routes/accounts.js';
import { marketDataRoutes } from './routes/marketdata.js';
import { tradingRoutes } from './routes/trading.js';
import { copyRoutes } from './routes/copy.js';
import { journalRoutes } from './routes/journal.js';
import { adminRoutes } from './routes/admin.js';
import { payoutRoutes } from './routes/payouts.js';
import { provisioningRoutes } from './routes/provisioning.js';
import { checkoutRoutes, commerceStatusRoutes, whopWebhookRoutes } from './routes/commerce.js';
import { customerConsoleRoutes } from './routes/customers.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { verifyRoutes } from './routes/verify.js';
import { portalRoutes } from './routes/portal.js';
import { enforcementAdminRoutes, enforcementPortalRoutes } from './routes/enforcement.js';
import { payoutOpsAdminRoutes, payoutOpsPortalRoutes, payoutWebhookRoutes } from './routes/payout-ops.js';
import { ownerStaffRoutes, staffOnboardingRoutes } from './routes/owner-staff.js';
import { ownerObservabilityRoutes } from './routes/owner-observability.js';
import { ownerAccountOpsRoutes } from './routes/owner-accounts.js';
import { ownerConfigRoutes } from './routes/owner-config.js';
import { ownerSystemRoutes } from './routes/owner-system.js';
import { ownerAlertRoutes } from './routes/owner-alerts.js';
import { ownerCustomerRoutes } from './routes/owner-customers2.js';
import { ownerIoRoutes } from './routes/owner-io.js';
import { ownerFinanceRoutes } from './routes/owner-finance.js';
import { ownerAffiliateRoutes } from './routes/owner-affiliates.js';
import { affiliatePublicRoutes } from './routes/affiliate-public.js';
import { affiliatePortalRoutes } from './routes/affiliate-portal.js';
import { ownerSupportRoutes } from './routes/owner-support.js';
import { supportPortalRoutes } from './routes/support-portal.js';
import { TradingEngine } from '../trading/engine.js';
import { AtlasSimulationExecutionProvider } from '../execution/provider.js';
import { ExecutionRegistry } from '../execution/registry.js';
import { RithmicExecutionProvider } from '../execution/providers/rithmic-execution.js';
import type { ExecutionProviderKind } from '@atlas/contracts';
import type { ExternalExecutionAdapter } from '../execution/external-provider.js';
import { buildMarketDataStack, type MarketDataStack } from '../marketdata/bootstrap.js';
import { sql as sqlRaw } from 'drizzle-orm';
import { getDb, getLockSql } from '../db/client.js';
import { releaseInfo } from '../config/release.js';
import { OutboxWorker, notifyAccountChanged } from '../platform/outbox.js';
import { PayoutOpsWorker } from '../platform/payout-ops-worker.js';
import { InactivityWorker } from '../platform/inactivity-worker.js';
import { accountOutboxHandler } from '../platform/projection.js';
import { listenAccountChanged } from '../platform/account-notify.js';
import { MarketDataGateway } from '../ws/gateway.js';
import { recordEngineActivity } from '../platform/engine-audit.js';
import { attachCopyBreachHandler } from '../platform/copy-breach.js';
import {
  certifyPassedEvaluations,
  fundEligibleQualifications,
  registerAutoCertification,
  registerAutoFunding,
} from '../platform/commerce-certify.js';
import { seedDefaultAgreements } from '../platform/agreements.js';
import { defaultOrganizationId } from '../platform/provisioning.js';
import { registerProvisioningRecovery, retryPendingProvisioning } from '../platform/commerce-fulfillment.js';
import { registerNotificationConsumer, startNotificationWorker } from '../platform/notifications.js';
import { registerRecognition } from '../platform/recognition.js';
import { runInactivitySweep } from '../platform/account-inactivity.js';

export interface BuiltApp {
  readonly app: FastifyInstance;
  readonly stack: MarketDataStack;
  readonly gateway: MarketDataGateway;
  readonly engine: TradingEngine;
}

/**
 * A safe per-request id. Every request gets a stable id used in structured logs
 * and the audit `Actor.requestId`, so a support ticket can be tied to exact log
 * lines. A CLIENT may propose one via `x-request-id` / `request-id` to correlate
 * across a call chain — but it is never trusted verbatim: only a short, plain
 * token (letters, digits, `-`, `_`, `.`, ≤64 chars) is accepted, otherwise a
 * fresh UUID is generated. This stops a hostile client from injecting newlines,
 * control characters, or unbounded junk into the log/audit stream via the id.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
export function safeRequestId(raw: unknown): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate)) return candidate;
  return randomUUID();
}

export async function buildApp(): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: isProduction() ? 'info' : 'warn',
      // Keep secrets and session material OUT of the structured log stream. This
      // is a payments/trading system: an access token, refresh token, cookie,
      // step-up token, or webhook signature in a log line is a credential leak.
      // pino redaction is path-based, so every place a secret can ride in is
      // listed explicitly — headers (authorization/cookie/step-up/webhook sig)
      // and the body fields that carry a password or token.
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-stepup-token"]',
        'req.headers["webhook-signature"]',
        'req.headers["x-whop-signature"]',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.newPassword',
        'req.body.currentPassword',
        'req.body.refreshToken',
        'req.body.token',
        'req.body.totp',
        'req.body.code',
        'req.body.secret',
      ],
    },
    // Every request gets a stable id (logs + audit Actor). A client-proposed
    // `x-request-id`/`request-id` is accepted only if it is a short plain token;
    // otherwise a UUID is generated — a hostile client cannot forge log events
    // or inject control characters through the id. See safeRequestId().
    genReqId: (req) => safeRequestId(req.headers['x-request-id'] ?? req.headers['request-id']),
    // OFF by default: `request.ip` is the real socket peer, so a client cannot
    // forge it via `X-Forwarded-For` to escape an IP-keyed rate limit. Turned on
    // only when TRUSTED_PROXY names a real proxy in front. See config/env.ts.
    trustProxy: trustProxyOption(),
    bodyLimit: 1024 * 512,
  });

  await app.register(cors, {
    origin: env().CORS_ORIGIN === '*' ? true : env().CORS_ORIGIN.split(','),
    credentials: true,
    // The browser cannot read a response header it has not been told about,
    // and the execution instrument needs the server's own timing. `x-request-id`
    // is exposed so a client can quote it in a support ticket and an operator can
    // grep the exact server log lines for that request.
    exposedHeaders: ['x-atlas-ms', 'x-request-id'],
  });

  await app.register(rateLimit, {
    global: false,
    max: 600,
    timeWindow: '1 minute',
  });

  // Several control endpoints (replay play/pause/reset) legitimately take no
  // body. A client that still sets a JSON content-type would otherwise be
  // rejected outright, so an empty body is read as an empty object.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body === undefined || body === null || body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch {
        /*
         * A body that is not JSON is the CALLER's mistake.
         *
         * Handing back the raw SyntaxError - which is what this did - loses
         * the one thing the error handler needs: a status. Fastify's own
         * parser raises a FastifyError carrying 400, but this parser replaced
         * it to let an empty body mean `{}`, and threw that typing away with
         * it. So every malformed body, on every route, came back as
         * `INTERNAL_ERROR` with a 500: Atlas reporting a client's typo as its
         * own failure, and paging whoever watches 5xx rates for it.
         */
        done(
          ApiError.badRequest(
            'MALFORMED_JSON',
            'The request body is not valid JSON.',
          ) as unknown as Error,
          undefined,
        );
      }
    },
  );

  registerAuth(app);

  /*
   * Security operational signal — a bounded, payload-free breadcrumb.
   *
   * Rate-limit blocks (429) and privileged authorization denials (403) are
   * ENFORCED elsewhere; here we make them VISIBLE to operators without alert
   * spam. This is a structured log line only — never an audit-chain row (which
   * an attacker could otherwise flood) and never a metric label (which would
   * explode cardinality). It carries only the safe, bounded fields: the event
   * name, the server-owned request id, the HTTP method, the matched ROUTE
   * PATTERN (`/api/v1/admin/...`, never the raw URL with ids), the response
   * code, and the actor id when a principal is attached. It NEVER logs the
   * request body, query, headers, or any attacker-supplied string, so a hostile
   * caller cannot forge a log event or inject a payload through it. Ordinary 401
   * (unauthenticated) and 404 are deliberately NOT signalled — that is normal
   * traffic, not an operational security event.
   */
  const logSecurityEvent = (
    request: Parameters<Parameters<typeof app.setErrorHandler>[0]>[1],
    event: 'rate_limit_blocked' | 'authz_denied',
    code: number,
  ): void => {
    request.log.warn(
      {
        securityEvent: event,
        requestId: request.id,
        method: request.method,
        route: request.routeOptions?.url ?? 'unmatched',
        code,
        actorId: (request as { user?: { id?: string } }).user?.id ?? null,
      },
      `security: ${event}`,
    );
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode === 403) logSecurityEvent(request, 'authz_denied', 403);
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, detail: error.detail } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request failed validation.',
          detail: { issues: error.issues },
        },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      logSecurityEvent(request, 'rate_limit_blocked', 429);
      return reply
        .code(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
    }

    // A framework error already carries a meaningful status and code. Reporting
    // a 400 as INTERNAL_ERROR sends the caller hunting for a server fault that
    // does not exist.
    const framework = error as { statusCode?: number; code?: string; message?: string };
    if (typeof framework.statusCode === 'number' && framework.statusCode < 500) {
      return reply.code(framework.statusCode).send({
        error: {
          code: framework.code ?? 'BAD_REQUEST',
          message: framework.message ?? 'Request could not be processed.',
        },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });

  /*
   * How long the server itself took.
   *
   * The browser can time a round trip, but a round trip is wire plus server
   * and a trader with a slow fill deserves to know which. Every response
   * carries the handler's own duration, so the execution instrument can
   * report "the server decided in 3ms and the wire cost 40" rather than one
   * number that explains nothing.
   */
  /*
   * Security response headers, on every response.
   *
   * Atlas serves JSON from the API and a separate static bundle for the web
   * app, so the policy here is deliberately strict: an API response should
   * never be sniffed into a script, framed, or leak a referrer. This is
   * defense-in-depth, dependency-free, and does not touch any handler.
   *
   * - nosniff: never let a browser second-guess our declared content type.
   * - frame denial + CSP frame-ancestors 'none': Atlas is never embedded.
   * - default-src 'none': an API response has no legitimate sub-resources.
   * - Referrer-Policy: no path/query leaks to any third party.
   * - Permissions-Policy: this origin asks for none of these capabilities.
   * - COOP/CORP: isolate this origin's browsing context and resources.
   * - HSTS: production only (meaningless, and harmful over plain http, in dev).
   */
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header(
      'content-security-policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('x-permitted-cross-domain-policies', 'none');
    if (isProduction()) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  app.addHook('onRequest', async (request) => {
    (request as { atlasStart?: number }).atlasStart = performance.now();
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const started = (request as { atlasStart?: number }).atlasStart;
    if (started !== undefined) {
      reply.header('x-atlas-ms', (performance.now() - started).toFixed(1));
    }
    // Echo the (safe, server-owned) request id so a client/support can correlate
    // a response to server log lines. Always the validated id, never raw client
    // input (see genReqId/safeRequestId).
    reply.header('x-request-id', String(request.id));
    return payload;
  });

  // Liveness: is the process up? Always 200 while the event loop runs. It must
  // NOT probe the database or providers — an orchestrator uses this only to
  // decide whether to restart the process, and a transient DB blip should never
  // trigger a restart loop. Release identity is included so an incident can be
  // tied to an exact build.
  app.get('/health', async () => ({
    status: 'ok',
    time: new Date().toISOString(),
    env: env().NODE_ENV,
    release: releaseInfo(),
  }));

  // Release identity on its own, for quick "which build is deployed?" checks.
  app.get('/version', async () => releaseInfo());

  // Readiness: is the process able to serve real traffic? This DOES probe the
  // one hard dependency — PostgreSQL, the sole source of truth — and returns 503
  // when it is unreachable, so a load balancer stops routing to a server that
  // cannot read/write business state. No fake green: a DB-down server reports
  // NOT ready even though the process is alive.
  app.get('/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'down'> = {};
    let ready = true;
    try {
      const t0 = performance.now();
      // Bound the probe: when Postgres is unreachable the driver would otherwise
      // block on connect, and readiness must answer FAST so a load balancer can
      // route away. Race the probe against a short timeout → a hung DB reads as
      // down (503), not as a stuck request.
      await Promise.race([
        getDb().db.execute(sqlRaw`select 1`),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('readiness DB probe timed out')), 2_000),
        ),
      ]);
      checks['database'] = 'ok';
      (checks as Record<string, unknown>)['database_ms'] = Number((performance.now() - t0).toFixed(1));
    } catch {
      checks['database'] = 'down';
      ready = false;
    }
    return reply.code(ready ? 200 : 503).send({ ready, time: new Date().toISOString(), release: releaseInfo(), checks });
  });

  const { db } = getDb();
  const stack = buildMarketDataStack(db);
  // A dedicated lock pool gives the engine its cross-process account lock; a
  // second Atlas instance sharing this database can no longer double-fill an
  // account. It is a separate pool so a held lock never starves queries.
  const engine = new TradingEngine(db, stack.market, getLockSql());
  // Order flow routes through the execution provider seam; today that is the
  // simulator wrapping this engine. A live provider would slot in here.
  const execution = new AtlasSimulationExecutionProvider(engine);
  // The execution registry decides — SERVER-SIDE — which provider serves an
  // account by mode. SIMULATION (the Atlas engine) is the default and the only
  // reachable path in this milestone; external adapters are registered as HONEST
  // seams (Rithmic reports UNCONFIGURED without server-side credentials and never
  // fakes CONNECTED). The scripted double is a test-only adapter and is NOT
  // registered here. Nothing about this is reachable from the browser.
  const externalAdapters = new Map<ExecutionProviderKind, ExternalExecutionAdapter>([
    ['rithmic', new RithmicExecutionProvider()],
  ]);
  const registry = new ExecutionRegistry(execution, externalAdapters);
  const gateway = new MarketDataGateway(stack.market, engine);
  gateway.register(app);

  /*
   * The platform record listens to the engine; the engine does not know it is
   * there. Fills become audit rows and domain events, and a terminal rule
   * outcome closes the account's lifecycle - all without a line of it inside
   * the matching path.
   */
  const stopRecording = recordEngineActivity(db, engine);

  /*
   * The commercial layer plugs in the same way: it certifies an evaluation the
   * instant the engine says PASSED, turning the reversible verdict into a
   * one-way qualification. The startup sweep recovers any pass a crash left
   * un-certified, so a qualification is never lost. The engine is untouched.
   */
  const stopCertifying = registerAutoCertification(db);
  void certifyPassedEvaluations(db).catch(() => undefined);

  /*
   * Automatic pass -> funded: certification emits evaluation.qualified, and this
   * funds it through the existing idempotent approveFunding so a normal customer
   * is funded without an employee. The startup sweep funds any ELIGIBLE
   * qualification a crash left un-funded. Exactly-once by approveFunding's lock +
   * fund:<qualId> idempotency key.
   */
  const stopAutoFunding = registerAutoFunding(db);
  void fundEligibleQualifications(db).catch(() => undefined);

  /*
   * Customer notifications attach here, strictly downstream: a committed domain
   * event records a notification intent (off the publishing call stack), and a
   * separate worker delivers it through the provider. Trading/payment/provisioning
   * never wait for email or SMS. With no Resend/Twilio credentials the mock
   * providers record what would have been sent; a real-but-unconfigured provider
   * SUPPRESSES rather than faking delivery.
   */
  const stopNotificationConsumer = registerNotificationConsumer(db);
  const stopNotificationWorker = startNotificationWorker(db);

  /*
   * A paid purchase whose identity/agreements gate was not yet satisfied parks
   * recoverably. This subscriber re-drives a customer's blocked orders the moment
   * they clear the gate, and the startup sweep recovers any left by a crash — so a
   * payment is never lost and provisioning is exactly-once and idempotent.
   */
  const stopProvisioningRecovery = registerProvisioningRecovery(db);
  void retryPendingProvisioning(db).catch(() => undefined);

  /*
   * Recognition: a deferred bystander issues certificates and achievements on
   * evaluation.qualified / account.funded / payout.paid / account.completed,
   * exactly once per triggering event. Downstream of the lifecycle; never blocks
   * it. Certificates carry only a SAFE public display name.
   */
  const stopRecognition = registerRecognition(db);

  /*
   * Copy trading reacts to a leader breach the same bystander way: when the
   * engine/lifecycle announces account.failed or account.locked, any ACTIVE
   * group led by that account is paused at once (never a silent promotion of a
   * follower; pausing flattens nothing). A follower breach needs no reaction —
   * its own risk pipeline isolates it while the group keeps trading.
   */
  const stopCopyBreach = attachCopyBreachHandler(db);

  /*
   * Funded-account inactivity closure is a scheduled sweep (runInactivitySweep),
   * driven by an external scheduler/cron on a calendar cadence — deliberately NOT
   * run eagerly at startup, where scanning every funded account would contend with
   * live provisioning/funding. It is idempotent and can be invoked on demand.
   */

  /*
   * Seed the required agreements (dev placeholder content) so the onboarding
   * gate has current versions to enforce. Idempotent — republishing identical
   * content is a no-op.
   */
  void defaultOrganizationId(db)
    .then((organizationId) => seedDefaultAgreements(db, organizationId))
    .catch(() => undefined);

  /*
   * The outbox delivery worker keeps the operational read model current and
   * wakes other instances. It drains account.changed events into the projection
   * and, after each committed batch, NOTIFYs so an instance holding a trader's
   * or owner's socket re-publishes even for a change processed elsewhere. Its
   * connection is the dedicated lock pool, kept off the query pool.
   */
  const workerPg = getLockSql();
  const outboxWorker = new OutboxWorker(db, {
    handler: accountOutboxHandler,
    onDelivered: (accountIds) => void notifyAccountChanged(workerPg, accountIds),
  });
  outboxWorker.start();

  const accountListener = await listenAccountChanged(workerPg, (accountId) => {
    void gateway.publishAccountState(accountId);
  }).catch((): null => null);

  /*
   * The durable payout-operations worker resumes work no single request can
   * guarantee: submitting PAYABLE payouts a treasury/breaker delay left behind and
   * retrying transient provider failures with the SAME idempotency key. Claims are
   * disjoint (`FOR UPDATE SKIP LOCKED`) and `submitPayable` re-locks the row and
   * no-ops unless still PAYABLE, so two instances can never double-submit and a
   * restart simply picks the durable rows back up. Without this loop a payout left
   * PAYABLE by a transient error would wait for a manual owner submit (HTF-26).
   */
  const payoutOpsWorker = new PayoutOpsWorker(db, { name: 'payout-ops' });
  payoutOpsWorker.start();

  /*
   * Funded-account inactivity enforcement (HTF-18). The monthly-inactivity rule
   * was implemented and disclosed but never bound to a scheduler, so it would
   * never fire. This runs the idempotent, server-time-authoritative sweep on a
   * slow cadence; an on-demand owner route also exists for manual runs.
   */
  const inactivityWorker = new InactivityWorker(db);
  inactivityWorker.start();

  app.addHook('onClose', async () => {
    stopRecording();
    stopCertifying();
    stopAutoFunding();
    stopProvisioningRecovery();
    stopRecognition();
    stopCopyBreach();
    stopNotificationConsumer();
    stopNotificationWorker();
    outboxWorker.stop();
    payoutOpsWorker.stop();
    inactivityWorker.stop();
    await accountListener?.close().catch(() => undefined);
    engine.stop();
    await stack.market.stop();
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(instrumentRoutes, { prefix: '/api/v1/instruments' });
  await app.register(accountRoutes, { prefix: '/api/v1/accounts' });
  await app.register(ruleTemplateRoutes, { prefix: '/api/v1/rule-templates' });
  await app.register(marketDataRoutes({ ...stack, engine }), { prefix: '/api/v1/marketdata' });
  await app.register(tradingRoutes({ engine, market: stack.market, execution }), { prefix: '/api/v1' });
  // Native copy trading orchestrates the same execution provider seam.
  await app.register(copyRoutes({ execution }), { prefix: '/api/v1/copy' });
  await app.register(journalRoutes({ engine, replay: stack.replay }), { prefix: '/api/v1/journal' });
  // The operator console and the machine-to-machine seam. Both are authorised
  // server-side; neither is reachable from the trading terminal's session.
  await app.register(adminRoutes({ engine, market: stack.market, registry }), { prefix: '/api/v1/admin' });
  // The payout engine: trader eligibility/requests and the owner queue/case/
  // exposure. Registered at /api/v1 so it carries both /payouts/* (trader) and
  // /admin/payouts/* (owner) under their own RBAC.
  await app.register(payoutRoutes(), { prefix: '/api/v1' });
  await app.register(provisioningRoutes, { prefix: '/api/v1/provisioning' });
  await app.register(customerConsoleRoutes, { prefix: '/api/v1/admin' });
  await app.register(checkoutRoutes(), { prefix: '/api/v1/checkout' });
  // The server-authoritative order status the onboarding UI polls (never the
  // browser's checkout callback), IDOR-guarded to the order's owner.
  await app.register(commerceStatusRoutes, { prefix: '/api/v1/commerce' });
  // The customer-facing onboarding flow (identity, contact, agreements, products).
  await app.register(onboardingRoutes, { prefix: '/api/v1/onboarding' });
  // Public, unauthenticated certificate verification (safe projection only).
  await app.register(verifyRoutes, { prefix: '/api/v1/verify' });
  // The customer portal: a trader's own accounts, analytics, reset, certificates,
  // achievements and profile. Every route is owner-scoped.
  await app.register(portalRoutes, { prefix: '/api/v1/portal' });
  await app.register(enforcementAdminRoutes(), { prefix: '/api/v1/admin/enforcement' });
  await app.register(enforcementPortalRoutes(), { prefix: '/api/v1/portal/enforcement' });
  // Payout Operations (M8): owner console, own-scoped portal, provider webhook.
  await app.register(payoutOpsAdminRoutes(), { prefix: '/api/v1/admin/payout-ops' });
  await app.register(payoutOpsPortalRoutes(), { prefix: '/api/v1/portal/payout-ops' });
  await app.register(payoutWebhookRoutes(), { prefix: '/api/v1/webhooks' });
  // Owner Operating System (M10): staff & access, granular RBAC, reauth,
  // impersonation — plus a public onboarding surface for invited staff.
  await app.register(ownerStaffRoutes(), { prefix: '/api/v1/admin' });
  await app.register(staffOnboardingRoutes(), { prefix: '/api/v1/staff-onboarding' });
  // Owner OS observability (M10-C): search, event timeline, correlation trace,
  // universal object explorer, state/rules inspectors.
  await app.register(ownerObservabilityRoutes(), { prefix: '/api/v1/admin/ops' });
  // Owner OS account operations (M10-E): preview, append-only adjustments,
  // pause/resume/disable/enable, provisioning retry.
  await app.register(ownerAccountOpsRoutes(), { prefix: '/api/v1/admin/ops' });
  // Owner OS configuration (M10-F): feature flags, kill switches, change history.
  await app.register(ownerConfigRoutes(), { prefix: '/api/v1/admin/ops' });
  // Owner OS System Doctor / integrity / reconciliation / full-system-test (M10-G).
  await app.register(ownerSystemRoutes(), { prefix: '/api/v1/admin/ops' });
  // Owner OS alerts + incidents + notification channels (M10-H).
  await app.register(ownerAlertRoutes(), { prefix: '/api/v1/admin/ops' });
  // Owner OS Customer Directory + tags + 360 aggregation (M10-D).
  await app.register(ownerCustomerRoutes(), { prefix: '/api/v1/admin/ops' });
  // Owner OS jobs/webhooks/providers/market/execution-quality (M10-I) + financial
  // ops/money-trace/exports/views/notes/tasks/agreements (M10-J).
  await app.register(ownerIoRoutes(), { prefix: '/api/v1/admin/ops' });
  await app.register(ownerFinanceRoutes(), { prefix: '/api/v1/admin/ops' });
  await app.register(ownerAffiliateRoutes(), { prefix: '/api/v1/admin/ops' });
  // Affiliate program: public intake/tracking + authenticated self-service portal.
  await app.register(affiliatePublicRoutes(), { prefix: '/api/v1/affiliates' });
  await app.register(affiliatePortalRoutes(), { prefix: '/api/v1/affiliates' });
  // Customer Support + Disputes + Resolution (M12).
  await app.register(ownerSupportRoutes(), { prefix: '/api/v1/admin/ops' });
  await app.register(supportPortalRoutes(), { prefix: '/api/v1/support' });
  // Public and signature-gated: the provider calls this, so it carries no session
  // auth. Provisioning is authorised ONLY here, from a verified server-side event.
  await app.register(whopWebhookRoutes, { prefix: '/api/v1/webhooks' });

  return { app, stack, gateway, engine };
}
