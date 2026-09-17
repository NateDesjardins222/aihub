/**
 * /api/v1/accounts and /api/v1/rule-templates
 *
 * Accounts are always read from the database. The client is never trusted with a
 * balance, a drawdown figure or an account status.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { accounts, ruleTemplates } from '../../db/schema.js';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';

const createAccountSchema = z.object({
  ruleTemplateId: z.string().uuid(),
  name: z.string().min(1).max(80),
});

type TemplateRow = typeof ruleTemplates.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;

function presentTemplate(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    accountType: t.accountType,
    accountSizeMicros: t.accountSizeMicros,
    profitTargetMicros: t.profitTargetMicros,
    maxLossMicros: t.maxLossMicros,
    drawdownType: t.drawdownType,
    trailingLockAtMicros: t.trailingLockAtMicros,
    dailyLossLimitMicros: t.dailyLossLimitMicros,
    consistencyFormula: t.consistencyFormula,
    consistencyThreshold: t.consistencyThreshold,
    maxContracts: t.maxContracts,
    microsCountAsFraction: t.microsCountAsFraction,
    minTradingDays: t.minTradingDays,
    maxTradingDays: t.maxTradingDays,
    payoutRules: t.payoutRules,
  };
}

/**
 * Account view without live mark prices. Open P&L arrives with the trading
 * engine in Milestone 5; until then these fields are explicitly zero rather
 * than fabricated.
 */
function presentAccount(a: AccountRow, t: TemplateRow) {
  const equityMicros = a.balanceMicros;
  return {
    id: a.id,
    name: a.name,
    accountType: a.accountType,
    status: a.status,
    ruleTemplate: presentTemplate(t),
    startingBalanceMicros: a.startingBalanceMicros,
    balanceMicros: a.balanceMicros,
    realizedPnlMicros: a.realizedPnlMicros,
    feesMicros: a.feesMicros,
    highWaterMarkMicros: a.highWaterMarkMicros,
    drawdownFloorMicros: a.drawdownFloorMicros,
    equityMicros,
    openPnlMicros: 0,
    dayPnlMicros: a.balanceMicros - a.dayStartBalanceMicros,
    remainingDrawdownMicros: equityMicros - a.drawdownFloorMicros,
    remainingDailyLossMicros:
      t.dailyLossLimitMicros === null
        ? null
        : t.dailyLossLimitMicros - (a.dayStartBalanceMicros - a.balanceMicros),
    profitTargetProgressMicros: a.balanceMicros - a.startingBalanceMicros,
    tradingDaysCount: a.tradingDaysCount,
    currentTradeDate: a.currentTradeDate,
    failedReason: a.failedReason,
    seq: a.seq,
    createdAt: a.createdAt.getTime(),
  };
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();
  app.addHook('preHandler', requireUser);

  app.get('/', async (request, reply) => {
    const rows = await db
      .select({ account: accounts, template: ruleTemplates })
      .from(accounts)
      .innerJoin(ruleTemplates, eq(accounts.ruleTemplateId, ruleTemplates.id))
      .where(eq(accounts.userId, request.user!.id))
      // Practice accounts first, largest programme first within each group, so
      // the terminal opens on the $150,000 practice account and can be traded
      // straight away with no setup.
      //
      // Sorted by the TEMPLATE's size rather than the account's current
      // starting balance: a practice session can reset an account to a
      // different balance, and the account it opens on should not change
      // because of something a session did last week.
      .orderBy(
        sql`case when ${accounts.accountType} = 'PRACTICE' then 0 else 1 end`,
        desc(ruleTemplates.accountSizeMicros),
        accounts.createdAt,
      );
    return reply.send({
      accounts: rows.map((r) => presentAccount(r.account, r.template)),
    });
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const [row] = await db
      .select({ account: accounts, template: ruleTemplates })
      .from(accounts)
      .innerJoin(ruleTemplates, eq(accounts.ruleTemplateId, ruleTemplates.id))
      .where(and(eq(accounts.id, request.params.id), eq(accounts.userId, request.user!.id)));
    if (!row) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
    return reply.send(presentAccount(row.account, row.template));
  });

  app.post('/', async (request, reply) => {
    const body = createAccountSchema.parse(request.body);
    const [template] = await db
      .select()
      .from(ruleTemplates)
      .where(eq(ruleTemplates.id, body.ruleTemplateId));
    if (!template) throw ApiError.notFound('TEMPLATE_NOT_FOUND', 'No such rule template.');

    const size = template.accountSizeMicros;
    const [row] = await db
      .insert(accounts)
      .values({
        userId: request.user!.id,
        ruleTemplateId: template.id,
        name: body.name,
        accountType: template.accountType,
        status: 'ACTIVE',
        startingBalanceMicros: size,
        balanceMicros: size,
        highWaterMarkMicros: size,
        drawdownFloorMicros: size - template.maxLossMicros,
        dayStartBalanceMicros: size,
        dayStartEquityMicros: size,
      })
      .returning();
    return reply.code(201).send(presentAccount(row!, template));
  });
}

export async function ruleTemplateRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();
  app.addHook('preHandler', requireUser);

  app.get('/', async (_request, reply) => {
    const rows = await db.select().from(ruleTemplates);
    return reply.send({ ruleTemplates: rows.map(presentTemplate) });
  });
}
