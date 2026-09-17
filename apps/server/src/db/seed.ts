/**
 * Seeds configurable prop-firm products and a demo trader.
 *
 * These numbers are configuration, not code: an administrator can create any
 * arbitrary product through the same table. Nothing in the risk, drawdown or
 * consistency engines is specialised to a particular account size.
 */
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { accounts, ruleTemplates, tradeTags, users } from './schema.js';
import { hashPassword } from '../auth/password.js';

const M = 1_000_000;

interface TemplateSeed {
  name: string;
  accountType: 'EVALUATION' | 'FUNDED' | 'PRACTICE';
  accountSize: number;
  profitTarget: number;
  maxLoss: number;
  drawdownType: 'STATIC' | 'INTRADAY_TRAILING' | 'EOD_TRAILING';
  trailingLockAt: number | null;
  dailyLossLimit: number | null;
  consistencyThreshold: number | null;
  maxContracts: number;
  minTradingDays: number;
  maxTradingDays: number | null;
}

const TEMPLATES: TemplateSeed[] = [
  {
    name: 'Atlas Evaluation 50K',
    accountType: 'EVALUATION',
    accountSize: 50_000,
    profitTarget: 3_000,
    maxLoss: 2_000,
    drawdownType: 'EOD_TRAILING',
    trailingLockAt: 2_000,
    dailyLossLimit: 1_000,
    consistencyThreshold: 0.5,
    maxContracts: 5,
    minTradingDays: 2,
    maxTradingDays: null,
  },
  {
    name: 'Atlas Evaluation 100K',
    accountType: 'EVALUATION',
    accountSize: 100_000,
    profitTarget: 6_000,
    maxLoss: 3_000,
    drawdownType: 'EOD_TRAILING',
    trailingLockAt: 3_000,
    dailyLossLimit: 2_000,
    consistencyThreshold: 0.5,
    maxContracts: 10,
    minTradingDays: 2,
    maxTradingDays: null,
  },
  {
    name: 'Atlas Evaluation 150K',
    accountType: 'EVALUATION',
    accountSize: 150_000,
    profitTarget: 9_000,
    maxLoss: 4_500,
    drawdownType: 'EOD_TRAILING',
    trailingLockAt: 4_500,
    dailyLossLimit: 3_000,
    consistencyThreshold: 0.5,
    maxContracts: 15,
    minTradingDays: 2,
    maxTradingDays: null,
  },
  {
    // Demonstrates that the drawdown TYPE is data, not a branch in the engine.
    name: 'Atlas Intraday-Trailing 50K',
    accountType: 'EVALUATION',
    accountSize: 50_000,
    profitTarget: 3_000,
    maxLoss: 2_000,
    drawdownType: 'INTRADAY_TRAILING',
    trailingLockAt: null,
    dailyLossLimit: 1_000,
    consistencyThreshold: 0.4,
    maxContracts: 5,
    minTradingDays: 3,
    maxTradingDays: 60,
  },
  {
    name: 'Atlas Static 100K',
    accountType: 'EVALUATION',
    accountSize: 100_000,
    profitTarget: 6_000,
    maxLoss: 3_000,
    drawdownType: 'STATIC',
    trailingLockAt: null,
    dailyLossLimit: null,
    consistencyThreshold: null,
    maxContracts: 10,
    minTradingDays: 0,
    maxTradingDays: null,
  },
  {
    /*
     * The account the terminal opens on.
     *
     * Deliberately permissive so the platform can be exercised without a rule
     * tripping, and deliberately generic: it is an ordinary row in the same
     * template table as every programme, with the same fields. Nothing about
     * any particular prop firm's programme is wired into the engine - the
     * size, the target, the drawdown TYPE and the contract cap are data.
     */
    name: 'Atlas Practice 150K',
    accountType: 'PRACTICE',
    accountSize: 150_000,
    profitTarget: 1_000_000,
    maxLoss: 150_000,
    drawdownType: 'STATIC',
    trailingLockAt: null,
    dailyLossLimit: null,
    consistencyThreshold: null,
    maxContracts: 50,
    minTradingDays: 0,
    maxTradingDays: null,
  },
  {
    // Deliberately permissive, for exercising the platform without tripping rules.
    name: 'Atlas Practice 100K',
    accountType: 'PRACTICE',
    accountSize: 100_000,
    profitTarget: 1_000_000,
    maxLoss: 100_000,
    drawdownType: 'STATIC',
    trailingLockAt: null,
    dailyLossLimit: null,
    consistencyThreshold: null,
    maxContracts: 50,
    minTradingDays: 0,
    maxTradingDays: null,
  },
];

async function main(): Promise<void> {
  const { sql, db } = createDb();
  try {
    const templateIds = new Map<string, string>();

    for (const t of TEMPLATES) {
      const existing = await db
        .select({ id: ruleTemplates.id })
        .from(ruleTemplates)
        .where(eq(ruleTemplates.name, t.name));
      if (existing[0]) {
        templateIds.set(t.name, existing[0].id);
        continue;
      }
      const [row] = await db
        .insert(ruleTemplates)
        .values({
          name: t.name,
          accountType: t.accountType,
          accountSizeMicros: t.accountSize * M,
          profitTargetMicros: t.profitTarget * M,
          maxLossMicros: t.maxLoss * M,
          drawdownType: t.drawdownType,
          trailingLockAtMicros: t.trailingLockAt === null ? null : t.trailingLockAt * M,
          dailyLossLimitMicros: t.dailyLossLimit === null ? null : t.dailyLossLimit * M,
          consistencyFormula: 'BEST_DAY_OVER_TOTAL',
          consistencyThreshold: t.consistencyThreshold,
          maxContracts: t.maxContracts,
          microsCountAsFraction: true,
          minTradingDays: t.minTradingDays,
          maxTradingDays: t.maxTradingDays,
          minDailyPnlToCountMicros: 0,
          payoutRules: {
            minTradingDaysForPayout: 10,
            maxPayoutPercent: 0.5,
            profitSplitPercent: 0.9,
            minPayoutMicros: 100 * M,
          },
          isSystem: true,
        })
        .returning();
      templateIds.set(t.name, row!.id);
    }
    console.log(`rule templates ready: ${templateIds.size}`);

    const demoEmail = 'demo@atlasfutures.local';
    let [demo] = await db.select().from(users).where(eq(users.email, demoEmail));
    if (!demo) {
      [demo] = await db
        .insert(users)
        .values({
          email: demoEmail,
          passwordHash: await hashPassword('atlas-demo-2026'),
          displayName: 'Demo Trader',
        })
        .returning();
      console.log('demo user created: demo@atlasfutures.local / atlas-demo-2026');
    }

    // A starting vocabulary for the journal. Every one of these is an ordinary
    // row the trader can rename or delete: the platform has no opinion about
    // what a mistake is called, and hardcoding these would make it have one.
    const STARTER_TAGS = [
      { name: 'A+ setup', color: 'green', kind: 'GOOD', sort: 10 },
      { name: 'Good execution', color: 'green', kind: 'GOOD', sort: 20 },
      { name: 'Managed well', color: 'teal', kind: 'GOOD', sort: 30 },
      { name: 'Early entry', color: 'amber', kind: 'BAD', sort: 40 },
      { name: 'Chased', color: 'amber', kind: 'BAD', sort: 50 },
      { name: 'FOMO', color: 'red', kind: 'BAD', sort: 60 },
      { name: 'Revenge', color: 'red', kind: 'BAD', sort: 70 },
      { name: 'Overtrade', color: 'red', kind: 'BAD', sort: 80 },
      { name: 'Rule break', color: 'red', kind: 'BAD', sort: 90 },
      { name: 'Counter-trend', color: 'slate', kind: 'NEUTRAL', sort: 100 },
      { name: 'News', color: 'slate', kind: 'NEUTRAL', sort: 110 },
    ] as const;

    const haveTags = await db
      .select({ id: tradeTags.id })
      .from(tradeTags)
      .where(eq(tradeTags.userId, demo!.id));
    if (haveTags.length === 0) {
      await db.insert(tradeTags).values(
        STARTER_TAGS.map((tag) => ({
          userId: demo!.id,
          name: tag.name,
          color: tag.color,
          kind: tag.kind,
          sort: tag.sort,
        })),
      );
      console.log(`journal tags seeded: ${STARTER_TAGS.length}`);
    }

    const existingAccounts = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.userId, demo!.id));
    const haveAccount = new Set(existingAccounts.map((row) => row.name));

    {
      // Checked per account rather than "are there any at all", so a database
      // seeded before this account existed still gets it. Nothing is touched
      // if it is already there: an account carries a balance and a history.
      let created = 0;
      for (const name of [
        'Atlas Practice 150K',
        'Atlas Evaluation 50K',
        'Atlas Evaluation 100K',
        'Atlas Evaluation 150K',
      ]) {
        if (haveAccount.has(name.replace('Atlas ', ''))) continue;
        created += 1;
        const template = TEMPLATES.find((t) => t.name === name)!;
        const size = template.accountSize * M;
        const floor = size - template.maxLoss * M;
        await db.insert(accounts).values({
          userId: demo!.id,
          ruleTemplateId: templateIds.get(name)!,
          name: name.replace('Atlas ', ''),
          accountType: template.accountType,
          status: 'ACTIVE',
          startingBalanceMicros: size,
          balanceMicros: size,
          highWaterMarkMicros: size,
          drawdownFloorMicros: floor,
          dayStartBalanceMicros: size,
          dayStartEquityMicros: size,
        });
      }
      console.log(`demo accounts created: ${created}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
