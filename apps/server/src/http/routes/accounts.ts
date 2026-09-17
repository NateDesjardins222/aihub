/**
 * /api/v1/accounts and /api/v1/rule-templates
 *
 * Accounts are always read from the database. The client is never trusted with a
 * balance, a drawdown figure or an account status.
 *
 * There is no endpoint here for CREATING an account. Accounts come from the
 * provisioning service - an administrator, a machine-to-machine call, or the
 * practice account a new trader is registered with - because "how many
 * accounts do I have and on what terms" is not a decision a browser gets to
 * make.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { accountProfileVersions, accountProfiles, accounts, ruleTemplates } from '../../db/schema.js';
import { ApiError } from '../errors.js';
import { requireUser } from '../auth-plugin.js';
import { loadAccountAndTemplate } from '../../trading/account-rules.js';

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
function presentAccount(a: AccountRow, t: TemplateRow, product?: ProductView | null) {
  const equityMicros = a.balanceMicros;
  return {
    id: a.id,
    /** The number a trader quotes to support. */
    publicId: a.publicId,
    name: a.name,
    product: product ?? null,
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
    instrumentLimits: a.instrumentLimits ?? null,
    activatedAt: a.activatedAt?.getTime() ?? null,
    seq: a.seq,
    createdAt: a.createdAt.getTime(),
  };
}

interface ProductView {
  readonly key: string;
  readonly name: string;
  readonly version: number;
}

/** Statuses a trader's selector shows. An archived account is not one of them. */
const VISIBLE_STATUSES = ['PENDING', 'ACTIVE', 'GOAL_REACHED', 'LOCKED', 'PASSED', 'FAILED'];

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDb();
  app.addHook('preHandler', requireUser);

  app.get('/', async (request, reply) => {
    const rows = await db
      .select({
        account: accounts,
        template: ruleTemplates,
        version: accountProfileVersions,
        profile: accountProfiles,
      })
      .from(accounts)
      // LEFT joins throughout: an account provisioned from a product has no
      // rule template, and one created before products has no version. An
      // inner join on either would hide half the platform's accounts.
      .leftJoin(ruleTemplates, eq(accounts.ruleTemplateId, ruleTemplates.id))
      .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
      .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
      .where(
        and(
          eq(accounts.userId, request.user!.id),
          inArray(accounts.status, VISIBLE_STATUSES),
        ),
      )
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
        // By the PRODUCT's size, not the account's current starting balance: a
        // practice session can reset an account to a different balance, and the
        // account the terminal opens on should not change because of something
        // a session did last week.
        sql`coalesce(
          (${accountProfileVersions.config} -> 'rules' ->> 'accountSizeMicros')::bigint,
          ${ruleTemplates.accountSizeMicros}
        ) desc`,
        accounts.createdAt,
      );

    // The rule figures come from the same loader the engine uses, so what a
    // trader is shown and what they are evaluated against cannot diverge.
    const presented = [];
    for (const row of rows) {
      const loaded = await loadAccountAndTemplate(db, row.account.id);
      const template = loaded?.template;
      if (!template) continue;
      presented.push(
        presentAccount(
          row.account,
          template,
          row.profile && row.version
            ? { key: row.profile.key, name: row.profile.name, version: row.version.version }
            : null,
        ),
      );
    }
    return reply.send({ accounts: presented });
  });

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const [row] = await db
      .select({ account: accounts, profile: accountProfiles, version: accountProfileVersions })
      .from(accounts)
      .leftJoin(accountProfileVersions, eq(accounts.profileVersionId, accountProfileVersions.id))
      .leftJoin(accountProfiles, eq(accountProfileVersions.profileId, accountProfiles.id))
      .where(and(eq(accounts.id, request.params.id), eq(accounts.userId, request.user!.id)));
    if (!row) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
    const loaded = await loadAccountAndTemplate(db, row.account.id);
    if (!loaded?.template) throw ApiError.notFound('ACCOUNT_NOT_FOUND', 'No such account.');
    return reply.send(
      presentAccount(
        row.account,
        loaded.template,
        row.profile && row.version
          ? { key: row.profile.key, name: row.profile.name, version: row.version.version }
          : null,
      ),
    );
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
