/**
 * HTTP surface for the payout engine.
 *
 * Trader routes act on the caller's OWN funded account; owner routes drive the
 * queue and the case. RBAC is enforced server-side: SUPPORT reads the owner
 * views, ADMIN acts on a payout, and a trader can only touch an account they
 * own. Real domain work is delegated to `platform/payouts`; nothing money-moving
 * happens in the handler.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { accounts, users } from '../../db/schema.js';
import { defaultOrganizationId } from '../../platform/provisioning.js';
import { requireRole, requireUser } from '../auth-plugin.js';
import { ApiError } from '../errors.js';
import type { Actor } from '../../platform/actor.js';
import {
  PayoutError,
  approvePayout,
  cancelPayout,
  getPayoutEligibility,
  markPaid,
  markProcessing,
  placeHold,
  rejectPayout,
  removeHold,
  requestPayout,
} from '../../platform/payouts.js';
import { firmExposure, getPayoutCase, listPayouts } from '../../platform/payout-queries.js';
import { runFastLane, submitPayable, getOperationByRequest } from '../../platform/payout-operations.js';
import { economicsRuns } from '../../db/schema.js';
import { desc } from 'drizzle-orm';
import {
  baseAssumptions,
  monteCarlo,
  reserveModel,
  scenario,
  sensitivity,
  simulate,
  withCapSchedule,
  type ScenarioName,
} from '../../platform/economics-sim.js';
// M13.0 economics engine (v2): full lifecycle + time/cash-flow + affiliate/refunds.
import {
  AUTHORITATIVE as ECON_AUTHORITATIVE,
  SCENARIO_NAMES as ECON_SCENARIOS,
  assumptionsSchema as econAssumptionsSchema,
  defaultAssumptions as econDefaultAssumptions,
  loadAuthoritativeProducts as econLoadProducts,
  runEconomics,
  serialize as econSerialize,
  type ScenarioName as EconScenarioName,
} from '../../platform/economics/index.js';

const confirmed = z.object({ confirm: z.literal(true), reason: z.string().min(3).max(500) });

function adminActor(request: { user?: { id: string; email: string } | undefined; ip?: string }): Actor {
  return { type: 'ADMIN', userId: request.user?.id ?? null, label: request.user?.email ?? null, ip: request.ip ?? null };
}
function traderActor(request: { user?: { id: string; email: string } | undefined; ip?: string }): Actor {
  return { type: 'USER', userId: request.user?.id ?? null, label: request.user?.email ?? null, ip: request.ip ?? null };
}

async function organizationOf(userId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, userId));
  return row?.organizationId ?? (await defaultOrganizationId(db));
}

function mapPayoutError(err: unknown): never {
  if (err instanceof PayoutError) {
    const status = err.code === 'ACCOUNT_NOT_FOUND' || err.code === 'PAYOUT_NOT_FOUND' ? 404 : err.code === 'INVALID_TRANSITION' ? 409 : 400;
    throw new ApiError(status, err.code, err.message, err.reason ? { reason: err.reason } : undefined);
  }
  throw err;
}

/** Confirm the account belongs to the calling trader. */
async function requireOwnAccount(userId: string, accountId: string) {
  const { db } = getDb();
  const [row] = await db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!row) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
  return row;
}

export function payoutRoutes() {
  return async function register(app: FastifyInstance): Promise<void> {
    const { db } = getDb();

    // -- trader: my eligibility + request ------------------------------------

    app.get<{ Params: { accountId: string } }>(
      '/payouts/eligibility/:accountId',
      { preHandler: requireUser },
      async (request) => {
        await requireOwnAccount(request.user!.id, request.params.accountId);
        try {
          const ctx = await getPayoutEligibility(db, request.params.accountId);
          return presentEligibility(ctx);
        } catch (err) {
          return mapPayoutError(err);
        }
      },
    );

    app.post<{ Body: unknown }>(
      '/payouts/requests',
      { preHandler: requireUser, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const body = z
          .object({
            accountId: z.string().uuid(),
            amountMicros: z.number().int().positive(),
            idempotencyKey: z.string().min(1).max(200).optional(),
          })
          .parse(request.body);
        await requireOwnAccount(request.user!.id, body.accountId);
        try {
          const row = await requestPayout(db, {
            accountId: body.accountId,
            userId: request.user!.id,
            requestedGrossMicros: body.amountMicros,
            idempotencyKey: body.idempotencyKey ?? null,
            actor: traderActor(request),
          });
          // Fast lane (M8): clean payouts straight-through process with no human
          // approval — run the checks, auto-approve, and submit. A failed check
          // routes to the explicit exception lane. Never blocks the response on a
          // provider error; the durable worker resumes anything left PAYABLE.
          let opState: string | null = null;
          try {
            const fl = await runFastLane(db, row.id, { actor: traderActor(request) });
            opState = fl.opState;
            if (fl.opState === 'PAYABLE') {
              const op = await submitPayable(db, row.id);
              opState = op.opState;
            }
          } catch { /* the request is created; operations recovers it */ }
          const op = await getOperationByRequest(db, row.id);
          return reply.code(201).send({ id: row.id, state: row.state, requestedGrossMicros: row.requestedGrossMicros, opState: opState ?? op?.opState ?? 'RECEIVED', customerSafeCategory: op?.customerSafeCategory ?? 'PREPARING' });
        } catch (err) {
          return mapPayoutError(err);
        }
      },
    );

    // -- owner: queue, case, exposure ----------------------------------------

    app.get(
      '/admin/payouts',
      { preHandler: requireRole('SUPPORT') },
      async (request) => {
        const q = z
          .object({ state: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().optional() })
          .parse(request.query);
        const organizationId = await organizationOf(request.user!.id);
        return listPayouts(db, organizationId, q);
      },
    );

    app.get(
      '/admin/payouts/exposure',
      { preHandler: requireRole('SUPPORT') },
      async (request) => {
        const organizationId = await organizationOf(request.user!.id);
        return firmExposure(db, organizationId);
      },
    );

    app.get<{ Params: { id: string } }>(
      '/admin/payouts/:id',
      { preHandler: requireRole('SUPPORT') },
      async (request) => {
        const organizationId = await organizationOf(request.user!.id);
        const found = await getPayoutCase(db, organizationId, request.params.id);
        if (!found) throw ApiError.notFound('PAYOUT_NOT_FOUND', 'No such payout.');
        return found;
      },
    );

    // -- owner: actions (ADMIN, reason-required for sensitive) ----------------

    const action = (
      path: string,
      run: (id: string, body: { reason?: string; holdKind?: string }, actor: Actor) => Promise<{ id: string; state: string }>,
      opts: { requireReason?: boolean; role?: 'ADMIN' | 'SUPER_ADMIN' } = {},
    ) => {
      app.post<{ Params: { id: string }; Body: unknown }>(
        `/admin/payouts/:id/${path}`,
        { preHandler: requireRole(opts.role ?? 'ADMIN'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
        async (request, reply) => {
          const organizationId = await organizationOf(request.user!.id);
          const found = await getPayoutCase(db, organizationId, request.params.id);
          if (!found) throw ApiError.notFound('PAYOUT_NOT_FOUND', 'No such payout.');
          const body = opts.requireReason
            ? confirmed.parse(request.body)
            : z.object({ reason: z.string().max(500).optional(), holdKind: z.enum(['RISK', 'FRAUD', 'MANUAL']).optional() }).parse(request.body ?? {});
          try {
            const row = await run(request.params.id, body, adminActor(request));
            return reply.send({ id: row.id, state: row.state });
          } catch (err) {
            return mapPayoutError(err);
          }
        },
      );
    };

    action('approve', (id, body, actor) => approvePayout(db, { payoutRequestId: id, actor, reason: body.reason ?? null }), { requireReason: true });
    action('reject', (id, body, actor) => rejectPayout(db, { payoutRequestId: id, actor, reason: body.reason ?? null }), { requireReason: true });
    action('hold', (id, body, actor) => placeHold(db, { payoutRequestId: id, actor, reason: body.reason ?? null, holdKind: (body.holdKind as 'RISK' | 'FRAUD' | 'MANUAL') ?? 'MANUAL' }), { requireReason: true });
    action('remove-hold', (id, body, actor) => removeHold(db, { payoutRequestId: id, actor, reason: body.reason ?? null }));
    action('cancel', (id, body, actor) => cancelPayout(db, { payoutRequestId: id, actor, reason: body.reason ?? null }), { requireReason: true });
    action('process', (id, _body, actor) => markProcessing(db, { payoutRequestId: id, actor }));
    action('pay', (id, _body, actor) => markPaid(db, { payoutRequestId: id, actor }));

    // -- economics simulator (owner-only, synthetic) -------------------------

    const SCENARIOS: ScenarioName[] = ['BASE', 'GOOD_FOR_FIRM', 'GOOD_FOR_TRADER', 'HIGH_PASS_RATE', 'HIGH_PAYOUT_RATE', 'HIGH_REPEAT_PAYOUT', 'HIGH_CAC', 'HIGH_FRAUD', 'DAILY_PAYOUT_STRESS', 'SELECT_HIGH_SKILL'];

    app.get('/admin/economics/scenarios', { preHandler: requireRole('SUPER_ADMIN') }, async () => ({
      scenarios: SCENARIOS,
      base: baseAssumptions(),
    }));

    app.post('/admin/economics/run', { preHandler: requireRole('SUPER_ADMIN'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
      const body = z
        .object({
          scenario: z.enum(SCENARIOS as [ScenarioName, ...ScenarioName[]]).default('BASE'),
          seed: z.number().int().default(2026),
          purchases: z.number().int().min(1000).max(1_000_000).default(100_000),
          trials: z.number().int().min(1).max(200).default(40),
        })
        .parse(request.body ?? {});
      const organizationId = await organizationOf(request.user!.id);
      const assumptions = scenario(body.scenario);
      const result = simulate(assumptions, body.seed, body.purchases);
      const sens = sensitivity(assumptions, body.seed, Math.min(body.purchases, 100_000));
      const mc = monteCarlo(assumptions, body.seed, body.trials, Math.min(body.purchases, 20_000));
      const caps = {
        conservative: simulate(withCapSchedule(assumptions, 'CONSERVATIVE'), body.seed, body.purchases),
        current: simulate(withCapSchedule(assumptions, 'CURRENT'), body.seed, body.purchases),
        generous: simulate(withCapSchedule(assumptions, 'GENEROUS'), body.seed, body.purchases),
      };
      const reserve = reserveModel(0, result.grossTraderPayoutsMicros, mc.payoutExpense, 1.5);
      const results = { result, sensitivity: sens, monteCarlo: mc, caps, reserve, scenario: body.scenario };
      const [saved] = await db
        .insert(economicsRuns)
        .values({ organizationId, seed: body.seed, purchases: body.purchases, assumptions, results, createdByUserId: request.user!.id })
        .returning({ id: economicsRuns.id });
      return { id: saved!.id, assumptions, ...results };
    });

    app.get('/admin/economics/runs', { preHandler: requireRole('SUPER_ADMIN') }, async (request) => {
      const organizationId = await organizationOf(request.user!.id);
      const rows = await db
        .select({ id: economicsRuns.id, seed: economicsRuns.seed, purchases: economicsRuns.purchases, createdAt: economicsRuns.createdAt })
        .from(economicsRuns)
        .where(eq(economicsRuns.organizationId, organizationId))
        .orderBy(desc(economicsRuns.createdAt))
        .limit(25);
      return { rows: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
    });

    // -- M13.0 economics engine (owner-only, MODELED/SIMULATION — never accounting) --
    // Runs are stored immutably in `economics_runs` (insert-only): the frozen
    // assumptions + full bundle make every run reproducible and auditable. Never any
    // production side effect. `purchases` column holds the customer count for this v2.

    app.get('/admin/economics/v2/config', { preHandler: requireRole('SUPER_ADMIN') }, async () => ({
      scenarios: ECON_SCENARIOS,
      base: econDefaultAssumptions(),
      authoritative: ECON_AUTHORITATIVE,
      products: econLoadProducts(),
    }));

    app.post('/admin/economics/v2/run', { preHandler: requireRole('SUPER_ADMIN'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
      const body = z
        .object({
          scenario: z.enum(ECON_SCENARIOS as [EconScenarioName, ...EconScenarioName[]]).default('BASE'),
          assumptions: econAssumptionsSchema.optional(),
          seed: z.number().int().default(2026),
          customers: z.number().int().min(1).max(200_000).default(5000),
          horizonDays: z.number().int().min(1).max(3650).default(365),
          trials: z.number().int().min(1).max(200).default(40),
          persist: z.boolean().default(true),
        })
        .parse(request.body ?? {});
      const bundle = runEconomics({
        scenario: body.scenario,
        assumptions: body.assumptions,
        seed: body.seed,
        customers: body.customers,
        horizonDays: body.horizonDays,
        trials: body.trials,
      });
      let id: string | null = null;
      if (body.persist) {
        const organizationId = await organizationOf(request.user!.id);
        const [saved] = await db
          .insert(economicsRuns)
          .values({
            organizationId,
            seed: body.seed,
            purchases: body.customers,
            assumptions: bundle.assumptions,
            results: { version: 'M13_V2', bundle },
            createdByUserId: request.user!.id,
          })
          .returning({ id: economicsRuns.id });
        id = saved!.id;
      }
      return { id, bundle };
    });

    app.get('/admin/economics/v2/runs', { preHandler: requireRole('SUPER_ADMIN') }, async (request) => {
      const organizationId = await organizationOf(request.user!.id);
      const rows = await db
        .select({ id: economicsRuns.id, seed: economicsRuns.seed, purchases: economicsRuns.purchases, results: economicsRuns.results, createdAt: economicsRuns.createdAt })
        .from(economicsRuns)
        .where(eq(economicsRuns.organizationId, organizationId))
        .orderBy(desc(economicsRuns.createdAt))
        .limit(50);
      const v2 = rows.filter((r) => (r.results as { version?: string } | null)?.version === 'M13_V2');
      return {
        rows: v2.slice(0, 25).map((r) => {
          const b = (r.results as { bundle?: { scenario?: string; horizonDays?: number; result?: { contributionMicros?: number } } }).bundle;
          return {
            id: r.id, seed: r.seed, customers: r.purchases, createdAt: r.createdAt.toISOString(),
            scenario: b?.scenario ?? null, horizonDays: b?.horizonDays ?? null,
            contributionMicros: b?.result?.contributionMicros ?? null,
          };
        }),
      };
    });

    app.get('/admin/economics/v2/run/:id/export', { preHandler: requireRole('SUPER_ADMIN') }, async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const query = z.object({ format: z.enum(['summary', 'product', 'timeline', 'assumptions', 'json']).default('json') }).parse(request.query ?? {});
      const organizationId = await organizationOf(request.user!.id);
      const [row] = await db
        .select({ results: economicsRuns.results })
        .from(economicsRuns)
        .where(and(eq(economicsRuns.id, params.id), eq(economicsRuns.organizationId, organizationId)))
        .limit(1);
      if (!row || (row.results as { version?: string } | null)?.version !== 'M13_V2') {
        throw new ApiError(404, 'not_found', 'economics run not found');
      }
      const bundle = (row.results as { bundle: Parameters<typeof econSerialize.summaryCsv>[0] }).bundle;
      if (query.format === 'json') {
        void reply.header('content-type', 'application/json; charset=utf-8');
        void reply.header('content-disposition', `attachment; filename="economics-${params.id}.json"`);
        return econSerialize.bundleJson(bundle);
      }
      const csv =
        query.format === 'summary' ? econSerialize.summaryCsv(bundle)
        : query.format === 'product' ? econSerialize.productCsv(bundle)
        : query.format === 'timeline' ? econSerialize.timelineCsv(bundle)
        : econSerialize.assumptionsCsv(bundle);
      void reply.header('content-type', 'text/csv; charset=utf-8');
      void reply.header('content-disposition', `attachment; filename="economics-${params.id}-${query.format}.csv"`);
      return csv;
    });
  };
}

function presentEligibility(ctx: Awaited<ReturnType<typeof getPayoutEligibility>>) {
  const e = ctx.eligibility;
  const held = ctx.enforcementHold === true;
  // A firm enforcement hold is surfaced as a distinct reason so the UI can show
  // "Eligible, temporarily under review" rather than economic ineligibility.
  const reasonCodes = held ? [...e.reasonCodes.filter((c) => c !== 'ELIGIBLE'), 'ENFORCEMENT_HOLD'] : e.reasonCodes;
  return {
    accountId: ctx.account.id,
    state: held ? 'NOT_ELIGIBLE' : e.state,
    enforcementHold: held,
    /** The economic decision, ignoring any enforcement hold (for the UI wording). */
    economicallyEligible: e.state === 'ELIGIBLE',
    reasonCodes,
    grossWithdrawableMicros: e.grossWithdrawableMicros,
    qualifyingWinningDays: e.qualifyingWinningDays,
    requiredWinningDays: ctx.policy.requiredWinningDays,
    bestDayMicros: e.bestDayMicros,
    consistencyRatio: e.consistencyRatio,
    payoutConsistencyThreshold: ctx.policy.payoutConsistencyThreshold,
    bufferEstablished: e.bufferEstablished,
    fundedBufferMicros: ctx.policy.fundedBufferMicros,
    dailyModeUnlocked: e.dailyModeUnlocked,
    minRequestMicros: e.minRequestMicros,
    maxRequestMicros: e.maxRequestMicros,
    profitSplitPercent: ctx.policy.profitSplitPercent,
    model: ctx.policy.model,
    balanceMicros: ctx.account.balanceMicros,
    startingBalanceMicros: ctx.account.startingBalanceMicros,
    // Milestone 6 — DAILY progressive qualifying balance (null on non-DAILY / first payout).
    previousDailyQualifyingBalanceMicros: e.previousDailyQualifyingBalanceMicros,
    currentQualifyingBalanceMicros: e.currentQualifyingBalanceMicros,
    requiredNextQualifyingBalanceMicros: e.requiredNextQualifyingBalanceMicros,
  };
}
