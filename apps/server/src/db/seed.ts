/**
 * Seeds configurable prop-firm products and a demo trader.
 *
 * These numbers are configuration, not code: an administrator can create any
 * arbitrary product through the same table. Nothing in the risk, drawdown or
 * consistency engines is specialised to a particular account size.
 */
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { accounts, ruleTemplates, users } from './schema.js';
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

    const existingAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, demo!.id));

    if (existingAccounts.length === 0) {
      for (const name of ['Atlas Evaluation 50K', 'Atlas Evaluation 100K', 'Atlas Practice 100K']) {
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
      console.log('demo accounts created: 3');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
