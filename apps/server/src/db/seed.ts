/**
 * Seeds configurable prop-firm products and a demo trader.
 *
 * These numbers are configuration, not code: an administrator can create any
 * arbitrary product through the same table. Nothing in the risk, drawdown or
 * consistency engines is specialised to a particular account size.
 */
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import {
  accountProfileVersions,
  accountProfiles,
  accounts,
  ruleTemplates,
  tradeTags,
  users,
} from './schema.js';
import { hashPassword } from '../auth/password.js';
import { publishProfileVersion } from '../platform/profiles.js';
import { provisionAccount, defaultOrganizationId } from '../platform/provisioning.js';

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

/** Publish version 1 of a product, unless it already has one. */
async function publishProductOnce(
  db: ReturnType<typeof createDb>['db'],
  organizationId: string,
  key: string,
  t: TemplateSeed,
): Promise<boolean> {
  const [profile] = await db.select().from(accountProfiles).where(eq(accountProfiles.key, key));
  if (profile) {
    const [version] = await db
      .select({ id: accountProfileVersions.id })
      .from(accountProfileVersions)
      .where(eq(accountProfileVersions.profileId, profile.id))
      .limit(1);
    if (version) return false;
  }

  await publishProfileVersion(db, {
    organizationId,
    key,
    name: t.name.replace(/^Atlas /, ''),
    accountType: t.accountType,
    description: `Seeded product: ${t.name}`,
    config: {
      rules: {
        accountSizeMicros: t.accountSize * M,
        profitTargetMicros: t.profitTarget * M,
        maxLossMicros: t.maxLoss * M,
        drawdownType: t.drawdownType,
        trailingLockAtMicros: t.trailingLockAt === null ? null : t.trailingLockAt * M,
        dailyLossLimitMicros: t.dailyLossLimit === null ? null : t.dailyLossLimit * M,
        dailyLossPolicy: 'LOCK_DAY',
        consistencyFormula: 'BEST_DAY_OVER_TOTAL',
        consistencyThreshold: t.consistencyThreshold,
        minTradingDays: t.minTradingDays,
        minWinningDays: 0,
        maxTradingDays: t.maxTradingDays,
        minDailyPnlToCountMicros: 0,
        minWinningDayPnlMicros: 1,
        maxContracts: t.maxContracts,
        microsCountAsFraction: true,
        flattenOnBreach: true,
      },
      execution: null,
      instruments: { allowed: null, maxContracts: t.maxContracts, perInstrument: {} },
      display: { startingBalanceMicros: t.accountSize * M },
      payoutRules: {
        minTradingDaysForPayout: 10,
        maxPayoutPercent: 0.5,
        profitSplitPercent: 0.9,
        minPayoutMicros: 100 * M,
      },
    },
    notes: 'Seeded',
  });
  return true;
}

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

    const organizationId = await defaultOrganizationId(db);

    /*
     * Products.
     *
     * The same numbers as the rule templates above, published through the
     * ordinary product service so a fresh database has exactly what a migrated
     * one has: a product with a version, which accounts are pinned to. Nothing
     * here is specific to any firm - a firm decides the values, Atlas enforces
     * them.
     */
    let published = 0;
    for (const t of TEMPLATES) {
      const key = t.name
        .replace(/^Atlas /, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      if (await publishProductOnce(db, organizationId, key, t)) published += 1;
    }
    console.log(`products published: ${published} (${TEMPLATES.length} total)`);

    // Demo and owner accounts carry KNOWN, published credentials. They exist so
    // a developer can clone and sign in; seeding them into a real deployment
    // would hand anyone who has read this file a SUPER_ADMIN login. So they are
    // development-only, by refusal, not by convention.
    const seedDemoAccounts = process.env['NODE_ENV'] !== 'production';
    if (!seedDemoAccounts) {
      console.log(
        'skipping demo and owner accounts: NODE_ENV=production. Create the first operator out of band.',
      );
    }
    if (seedDemoAccounts) {
    const demoEmail = 'demo@atlasfutures.local';
    let [demo] = await db.select().from(users).where(eq(users.email, demoEmail));
    if (!demo) {
      [demo] = await db
        .insert(users)
        .values({
          email: demoEmail,
          passwordHash: await hashPassword('atlas-demo-2026'),
          displayName: 'Demo Trader',
          organizationId,
        })
        .returning();
      console.log('demo user created: demo@atlasfutures.local / atlas-demo-2026');
    }

    // An initial operator, so the Owner Control Center has someone to sign in
    // as. A firm needs one super-admin to exist before it can grant anyone
    // else a role; this is that seat.
    const ownerEmail = 'owner@atlasfutures.local';
    const [existingOwner] = await db.select().from(users).where(eq(users.email, ownerEmail));
    if (!existingOwner) {
      await db.insert(users).values({
        email: ownerEmail,
        passwordHash: await hashPassword('atlas-owner-2026'),
        displayName: 'Atlas Operator',
        organizationId,
        role: 'SUPER_ADMIN',
        isAdmin: true,
      });
      console.log('owner user created: owner@atlasfutures.local / atlas-owner-2026');
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
      /*
       * Demo accounts, provisioned through the ordinary service.
       *
       * Not inserted directly: the seed uses the same path an administrator
       * and a purchase webhook use, so a development database exercises the
       * lifecycle, the audit trail and the product pinning like any other.
       * Idempotent by key, so re-seeding never produces a second account.
       */
      let created = 0;
      for (const name of [
        'Atlas Practice 150K',
        'Atlas Evaluation 50K',
        'Atlas Evaluation 100K',
        'Atlas Evaluation 150K',
      ]) {
        const display = name.replace('Atlas ', '');
        if (haveAccount.has(display)) continue;
        const key = display.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        await provisionAccount(db, {
          organizationId,
          userId: demo!.id,
          profileKey: key,
          displayName: display,
          idempotencyKey: `seed:${demo!.id}:${key}`,
          actor: { type: 'SYSTEM', label: 'seed' },
        });
        created += 1;
      }
      console.log(`demo accounts provisioned: ${created}`);
    }
    } // end seedDemoAccounts
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
