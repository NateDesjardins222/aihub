/**
 * PostgreSQL schema.
 *
 * Money is stored as bigint micro-dollars and prices as integer ticks. There is
 * no floating-point column anywhere in the financial tables — a `double
 * precision` balance is a correctness defect, not a style preference.
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** bigint columns come back as strings from postgres.js; this keeps them numeric. */
const micros = (name: string) => bigint(name, { mode: 'number' });

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/**
 * The firm a user, a product and an account belong to.
 *
 * Atlas is one row in this table, not the assumption behind every other one.
 * Nothing in this milestone builds a white-label customisation surface; the
 * point is that adding the second organisation later is a row, not a rewrite.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable machine name, e.g. `atlas`. */
    slug: varchar('slug', { length: 40 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
    /** Opaque presentation settings. Never read by the engine. */
    branding: jsonb('branding').notNull().default({}),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug)],
);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 60 }).notNull(),
    /**
     * Mirrors `role` for tokens issued before roles existed.
     *
     * Authorization reads `role`. This column is kept in step so a session that
     * is already open does not lose its access mid-flight, and is dropped once
     * every issued token has expired.
     */
    isAdmin: boolean('is_admin').notNull().default(false),
    /** TRADER | SUPPORT | ADMIN | SUPER_ADMIN. */
    role: varchar('role', { length: 16 }).notNull().default('TRADER'),
    /** ACTIVE | DISABLED. A disabled user cannot sign in or trade. */
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
    organizationId: uuid('organization_id').references(() => organizations.id),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    index('users_org_idx').on(t.organizationId),
  ],
);

/** Rotating refresh tokens. Only the hash is stored, never the token itself. */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Set when this token is rotated, so replay of an old token is detectable. */
    replacedByTokenHash: text('replaced_by_token_hash'),
    userAgent: text('user_agent'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_key').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Prop account products
// ---------------------------------------------------------------------------

export const ruleTemplates = pgTable('rule_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  accountType: varchar('account_type', { length: 20 }).notNull(),
  accountSizeMicros: micros('account_size_micros').notNull(),
  profitTargetMicros: micros('profit_target_micros').notNull(),
  maxLossMicros: micros('max_loss_micros').notNull(),
  drawdownType: varchar('drawdown_type', { length: 24 }).notNull(),
  trailingLockAtMicros: micros('trailing_lock_at_micros'),
  dailyLossLimitMicros: micros('daily_loss_limit_micros'),
  consistencyFormula: varchar('consistency_formula', { length: 32 }).notNull(),
  consistencyThreshold: real('consistency_threshold'),
  maxContracts: integer('max_contracts').notNull(),
  microsCountAsFraction: boolean('micros_count_as_fraction').notNull().default(false),
  minTradingDays: integer('min_trading_days').notNull().default(0),
  maxTradingDays: integer('max_trading_days'),
  minDailyPnlToCountMicros: micros('min_daily_pnl_to_count_micros').notNull().default(0),
  /** Days the account must finish in profit, not merely trade. */
  minWinningDays: integer('min_winning_days').notNull().default(0),
  /** Net profit that makes a day a WINNING day. */
  minWinningDayPnlMicros: micros('min_winning_day_pnl_micros').notNull().default(1),
  /** LOCK_DAY ends the day; FAIL ends the programme. */
  dailyLossPolicy: varchar('daily_loss_policy', { length: 12 }).notNull().default('LOCK_DAY'),
  /** Close open positions and working orders when a rule breaches. */
  flattenOnBreach: boolean('flatten_on_breach').notNull().default(true),
  payoutRules: jsonb('payout_rules').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: now(),
});

/**
 * A product an account can be provisioned from: "Practice 150K",
 * "Evaluation A", or whatever a firm decides to sell.
 *
 * The profile is the NAME. Its terms live in versions, because a firm that
 * edits a product must not thereby edit the terms of the accounts already
 * trading it.
 */
export const accountProfiles = pgTable(
  'account_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** Stable machine name used by provisioning callers, e.g. `practice-150k`. */
    key: varchar('key', { length: 60 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    accountType: varchar('account_type', { length: 20 }).notNull(),
    /** ACTIVE | RETIRED. Retiring stops new provisioning, never existing accounts. */
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
    description: text('description'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('account_profiles_org_key').on(t.organizationId, t.key)],
);

/**
 * One immutable version of a product's terms.
 *
 * `config` holds the whole configuration - rules, execution environment,
 * permitted instruments and sizing - and an account is pinned to a VERSION.
 * Editing a product publishes version N+1; accounts on version N keep their
 * terms for ever. That is the requirement stated as a foreign key.
 *
 * Rows are never updated once published. The table is append-only by
 * convention here and by trigger in the migration.
 */
export const accountProfileVersions = pgTable(
  'account_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => accountProfiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /** { rules, execution, instruments, display } - see the plan document. */
    config: jsonb('config').notNull(),
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [uniqueIndex('account_profile_versions_key').on(t.profileId, t.version)],
);

/**
 * A working draft of a product's terms, before it becomes a version.
 *
 * A version is immutable; a draft is the opposite - it is where an operator
 * composes and revises an edit until it is right, then publishes it. Publishing
 * a draft writes version N+1 and clears the draft. There is at most one draft
 * per product key per firm, so two operators editing the same product see one
 * shared work-in-progress rather than silently clobbering each other's fields.
 *
 * `profileId` is null for a brand-new product that has never been published;
 * `baseVersion` is the version the draft was started from, so the UI can warn
 * if a newer version was published underneath it.
 */
export const accountProfileDrafts = pgTable(
  'account_profile_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    profileId: uuid('profile_id').references(() => accountProfiles.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 60 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    accountType: varchar('account_type', { length: 20 }).notNull(),
    description: text('description'),
    config: jsonb('config').notNull(),
    notes: text('notes'),
    /** The published version this draft was started from; null for a new product. */
    baseVersion: integer('base_version'),
    updatedByUserId: uuid('updated_by_user_id').references(() => users.id),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('account_profile_drafts_org_key').on(t.organizationId, t.key)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The number a trader and a support agent say out loud: `SIM-000284`.
     *
     * Public, stable and unique. The primary key is a UUID and stays out of
     * sight; nobody reads a UUID down a telephone.
     */
    publicId: varchar('public_id', { length: 24 })
      .notNull()
      // Generated by the database from a sequence, so two concurrent
      // provisioning calls cannot produce the same number and no application
      // code has to remember to set one.
      .default(sql`'SIM-' || lpad(nextval('account_public_id_seq')::text, 6, '0')`),
    organizationId: uuid('organization_id').references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The programme this account was provisioned from, before profiles existed.
     *
     * Nullable now: an account provisioned from a profile version carries its
     * terms there instead. Accounts created before profiles keep pointing here
     * and the rule loader falls back to it, so no existing account changes.
     */
    ruleTemplateId: uuid('rule_template_id').references(() => ruleTemplates.id),
    /** The pinned version of the product. Preferred over the template. */
    profileVersionId: uuid('profile_version_id').references(() => accountProfileVersions.id),
    name: varchar('name', { length: 80 }).notNull(),
    accountType: varchar('account_type', { length: 20 }).notNull(),
    /**
     * What the account IS, to everything that reads it: the rule engine's
     * outcome, unless an operator has put a hold on it.
     */
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    /**
     * An operator's decision: PENDING, LOCKED, DISABLED or ARCHIVED. Null when
     * there is none.
     *
     * Separate from the rule status because the two answer different
     * questions. A day-lockout the rules imposed expires by itself; an
     * administrator's lock does not, and the rule engine must not be able to
     * lift it by re-evaluating a mark.
     */
    adminHold: varchar('admin_hold', { length: 20 }),
    /**
     * The rule engine's own view, which it keeps advancing underneath a hold
     * so that lifting one returns the account to where the rules say it is.
     */
    ruleStatus: varchar('rule_status', { length: 20 }).notNull().default('ACTIVE'),
    startingBalanceMicros: micros('starting_balance_micros').notNull(),
    balanceMicros: micros('balance_micros').notNull(),
    realizedPnlMicros: micros('realized_pnl_micros').notNull().default(0),
    feesMicros: micros('fees_micros').notNull().default(0),
    highWaterMarkMicros: micros('high_water_mark_micros').notNull(),
    drawdownFloorMicros: micros('drawdown_floor_micros').notNull(),
    tradingDaysCount: integer('trading_days_count').notNull().default(0),
    winningDaysCount: integer('winning_days_count').notNull().default(0),
    /** Best single day's net profit, which the consistency rule divides by. */
    bestDayProfitMicros: micros('best_day_profit_micros').notNull().default(0),
    /** Trading date a day-lockout ends on, exclusive. Null when not locked. */
    lockedUntilDate: date('locked_until_date'),
    /** Per-account rule overrides, merged over the programme's template. */
    ruleOverrides: jsonb('rule_overrides'),
    currentTradeDate: date('current_trade_date'),
    dayStartBalanceMicros: micros('day_start_balance_micros').notNull(),
    dayStartEquityMicros: micros('day_start_equity_micros').notNull(),
    /** Monotonic event sequence used for WebSocket snapshot/delta recovery. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    /**
     * Per-account simulation environment: fill model, latency, slippage,
     * liquidity cap, fee handling. Data, so one trader can be evaluated under
     * different assumptions from another without a code change.
     */
    simulationEnvironment: jsonb('simulation_environment'),
    /**
     * Permitted instruments and sizing for THIS account, over the profile's.
     * `{ allowed: ['NQ'], maxContracts: 5, perInstrument: { NQ: 3 } }`.
     */
    instrumentLimits: jsonb('instrument_limits'),
    /**
     * Whatever the provisioning caller wanted to keep with the account - an
     * external order id, a customer reference. Opaque: Atlas stores it, shows
     * it to admins, and never interprets it.
     */
    externalMetadata: jsonb('external_metadata'),
    /** When the account first became tradeable, which is not when it was created. */
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    /** The lifecycle a reset opens. History before it is preserved, not erased. */
    currentLifecycleId: uuid('current_lifecycle_id'),
    failedReason: text('failed_reason'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('accounts_user_idx').on(t.userId),
    index('accounts_org_idx').on(t.organizationId),
    uniqueIndex('accounts_public_id_key').on(t.publicId),
    index('accounts_status_idx').on(t.status),
  ],
);

/**
 * One life of an account: from provisioning, or from a reset, to the next
 * reset.
 *
 * A reset must not destroy what happened before it, so it closes the current
 * lifecycle and opens another. Orders, fills and trades are attributed to a
 * lifecycle by TIME - `started_at <= t < ended_at` - rather than by stamping a
 * column on every execution, which keeps the reset entirely out of the
 * matching path.
 */
export const accountLifecycles = pgTable(
  'account_lifecycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** 1 for the first life, 2 after the first reset, and so on. */
    seq: integer('seq').notNull(),
    profileVersionId: uuid('profile_version_id').references(() => accountProfileVersions.id),
    startingBalanceMicros: micros('starting_balance_micros').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** RESET | PASSED | FAILED | ARCHIVED - why this life ended. */
    endReason: varchar('end_reason', { length: 24 }),
    finalBalanceMicros: micros('final_balance_micros'),
    finalStatus: varchar('final_status', { length: 20 }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('account_lifecycles_seq_key').on(t.accountId, t.seq),
    index('account_lifecycles_account_idx').on(t.accountId, t.startedAt),
  ],
);

// ---------------------------------------------------------------------------
// Trading
// ---------------------------------------------------------------------------

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Idempotency key. The unique index below is what actually prevents double submits. */
    clientOrderId: varchar('client_order_id', { length: 128 }).notNull(),
    symbol: varchar('symbol', { length: 12 }).notNull(),
    /** The tradable contract this order intended, e.g. "NQZ26". Null = root only. */
    contractCode: varchar('contract_code', { length: 24 }),
    side: varchar('side', { length: 4 }).notNull(),
    qty: integer('qty').notNull(),
    filledQty: integer('filled_qty').notNull().default(0),
    type: varchar('type', { length: 16 }).notNull(),
    limitTicks: integer('limit_ticks'),
    stopTicks: integer('stop_ticks'),
    tif: varchar('tif', { length: 4 }).notNull().default('DAY'),
    status: varchar('status', { length: 20 }).notNull(),
    /**
     * Sum of price x qty x tickValue across every fill, micro-dollars.
     * Average fill price is DERIVED from this rather than stored: a float
     * average accumulates error across partial fills, and an order's average
     * price feeds directly into realized P&L.
     */
    fillNotionalMicros: micros('fill_notional_micros').notNull().default(0),
    /** A stop-limit that has been elected behaves as a limit from then on. */
    stopTriggered: boolean('stop_triggered').notNull().default(false),
    /** False while the order is still marketable; see FillDecision.marketable. */
    hasRested: boolean('has_rested').notNull().default(false),
    /**
     * Exchange time the order started resting at, null until it does.
     *
     * A closed bar may only fill an order that was already working when that
     * bar opened, so the engine compares the bar's open against this.
     */
    restedMarketTs: bigint('rested_market_ts', { mode: 'number' }),
    /** Wall clock from which the order may fill; models submission latency. */
    eligibleAt: bigint('eligible_at', { mode: 'number' }).notNull().default(0),
    /** Trading date the order belongs to, for DAY expiry. */
    tradingDate: date('trading_date'),
    ocoGroupId: uuid('oco_group_id'),
    parentOrderId: uuid('parent_order_id'),
    /**
     * Bracket offsets requested with an ENTRY order, in ticks.
     *
     * Stored rather than held in the request handler, because an entry rarely
     * fills on submission: latency, a resting limit or an unreachable price all
     * mean the fill lands on a later market event, and the protective legs are
     * created from the actual fill price at that point.
     */
    bracketConfig: jsonb('bracket_config'),
    bracketRole: varchar('bracket_role', { length: 16 }).notNull().default('STANDALONE'),
    trailTicks: integer('trail_ticks'),
    trailAnchorTicks: integer('trail_anchor_ticks'),
    rejectReason: varchar('reject_reason', { length: 40 }),
    /** Optimistic concurrency: a drag-modify carrying a stale version is rejected. */
    version: integer('version').notNull().default(0),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_client_id_key').on(t.accountId, t.clientOrderId),
    index('orders_account_status_idx').on(t.accountId, t.status),
    index('orders_symbol_idx').on(t.symbol, t.status),
    index('orders_oco_idx').on(t.ocoGroupId),
  ],
);

export const executions = pgTable(
  'executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    symbol: varchar('symbol', { length: 12 }).notNull(),
    /** The tradable contract this fill happened in, e.g. "NQZ26". Null = root only. */
    contractCode: varchar('contract_code', { length: 24 }),
    side: varchar('side', { length: 4 }).notNull(),
    qty: integer('qty').notNull(),
    priceTicks: integer('price_ticks').notNull(),
    feesMicros: micros('fees_micros').notNull().default(0),
    realizedPnlMicros: micros('realized_pnl_micros').notNull().default(0),
    slippageTicks: integer('slippage_ticks').notNull().default(0),
    liquidity: varchar('liquidity', { length: 8 }).notNull().default('TAKER'),
    execTime: timestamp('exec_time', { withTimezone: true }).notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    createdAt: now(),
  },
  (t) => [
    index('executions_account_idx').on(t.accountId, t.execTime),
    index('executions_order_idx').on(t.orderId),
  ],
);

export const positions = pgTable(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    symbol: varchar('symbol', { length: 12 }).notNull(),
    side: varchar('side', { length: 6 }).notNull().default('FLAT'),
    /** Signed: positive long, negative short. */
    qty: integer('qty').notNull().default(0),
    /**
     * Signed notional of the OPEN quantity in micro-dollars. Average entry is
     * derived from it. Storing a float average instead lets rounding error
     * accumulate into every subsequent realized P&L figure.
     */
    costBasisMicros: micros('cost_basis_micros').notNull().default(0),
    realizedPnlMicros: micros('realized_pnl_micros').notNull().default(0),
    feesMicros: micros('fees_micros').notNull().default(0),
    /**
     * How far the OPEN position has gone against and for the trader, in
     * micro-dollars, since it was opened. Updated from genuine marks only; the
     * lots closed out of this position inherit them.
     */
    maeMicros: micros('mae_micros').notNull().default(0),
    mfeMicros: micros('mfe_micros').notNull().default(0),
    /**
     * The market-data source this position was opened against.
     *
     * Market data is global and accounts are not: starting a practice replay
     * used to re-mark every open position at the recording's prices, which
     * reported losses and profits that no execution justified. A mark from a
     * different era does not apply to this position, and its P&L reads as
     * unknown instead.
     */
    marketEra: varchar('market_era', { length: 80 }),
    /**
     * The actual tradeable contract this position was opened in — e.g. NQZ26.
     *
     * A futures position belongs to a specific listed contract, not just a root.
     * This is stamped when the position opens and NEVER silently rewritten to a
     * later front month: when the continuous/front contract rolls, this position
     * stays on the contract it was opened in, and it is only marked by that
     * contract's prices (the open-position contract lock). Null means the row
     * predates contract identity, or the root could not be resolved — "root
     * only", never a wrong contract.
     */
    contractCode: varchar('contract_code', { length: 24 }),
    /** Distance to the protective stop when the position opened. Null if none. */
    initialRiskMicros: micros('initial_risk_micros'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [uniqueIndex('positions_account_symbol_key').on(t.accountId, t.symbol)],
);

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    symbol: varchar('symbol', { length: 12 }).notNull(),
    /** The tradable contract this round-trip traded, e.g. "NQZ26". Null = root only. */
    contractCode: varchar('contract_code', { length: 24 }),
    side: varchar('side', { length: 6 }).notNull(),
    qty: integer('qty').notNull(),
    /** Fractional by nature (a weighted average of tick prices), scaled x1e6. */
    entryTicksScaled: bigint('entry_ticks_scaled', { mode: 'number' }).notNull(),
    exitTicksScaled: bigint('exit_ticks_scaled', { mode: 'number' }).notNull(),
    entryTime: timestamp('entry_time', { withTimezone: true }).notNull(),
    exitTime: timestamp('exit_time', { withTimezone: true }).notNull(),
    grossPnlMicros: micros('gross_pnl_micros').notNull(),
    feesMicros: micros('fees_micros').notNull(),
    netPnlMicros: micros('net_pnl_micros').notNull(),
    /** Worst and best unrealized P&L this trade saw while it was open. */
    maeMicros: micros('mae_micros').notNull().default(0),
    mfeMicros: micros('mfe_micros').notNull().default(0),
    /** What it risked at entry. Null when taken without a stop, so R is undefined. */
    initialRiskMicros: micros('initial_risk_micros'),
    /** The practice session it belongs to, when it was taken inside one. */
    sessionId: uuid('session_id'),
    notes: text('notes'),
    tradeDate: date('trade_date').notNull(),
    createdAt: now(),
  },
  (t) => [
    index('trades_account_idx').on(t.accountId, t.exitTime),
    index('trades_date_idx').on(t.accountId, t.tradeDate),
    index('trades_session_idx').on(t.sessionId),
  ],
);

// ---------------------------------------------------------------------------
// Practice, journal and preferences
// ---------------------------------------------------------------------------

/**
 * One sitting at the terminal.
 *
 * A session is what a review is written about: which market was traded, under
 * which training mode, with what visible, and what came of it. The summary is
 * written once when the session ends so the record cannot drift as later trades
 * arrive - and it is shaped so an analysis layer can be added on top of it
 * later without the trading engine knowing anything about it.
 */
export const practiceSessions = pgTable(
  'practice_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: varchar('source', { length: 12 }).notNull().default('REPLAY'),
    mode: varchar('mode', { length: 24 }).notNull().default('STANDARD'),
    config: jsonb('config'),
    recordingId: varchar('recording_id', { length: 120 }),
    symbol: varchar('symbol', { length: 12 }),
    tradingDate: date('trading_date'),
    dateHidden: boolean('date_hidden').notNull().default(false),
    startingBalanceMicros: micros('starting_balance_micros').notNull(),
    endingBalanceMicros: micros('ending_balance_micros'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    summary: jsonb('summary'),
    notes: text('notes'),
    createdAt: now(),
  },
  (t) => [index('practice_sessions_account_idx').on(t.accountId, t.startedAt)],
);

/** The trader's own vocabulary. Nothing here is hardcoded by the platform. */
export const tradeTags = pgTable(
  'trade_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 40 }).notNull(),
    color: varchar('color', { length: 16 }).notNull().default('slate'),
    kind: varchar('kind', { length: 12 }).notNull().default('NEUTRAL'),
    sort: integer('sort').notNull().default(0),
    createdAt: now(),
  },
  (t) => [uniqueIndex('trade_tags_user_name_key').on(t.userId, t.name)],
);

export const tradeTagLinks = pgTable(
  'trade_tag_links',
  {
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => trades.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tradeTags.id, { onDelete: 'cascade' }),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.tradeId, t.tagId] })],
);

export const sessionTagLinks = pgTable(
  'session_tag_links',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => practiceSessions.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tradeTags.id, { onDelete: 'cascade' }),
    createdAt: now(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.tagId] })],
);

/** Where preferences live between sessions. Display only; never trading state. */
export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A trader's drawings.
 *
 * Separate from `user_preferences` because they are the one thing in that blob
 * with no upper bound: a marked-up chart can carry hundreds of objects, and a
 * shared 64 KB budget meant the drawings eventually took the rest of the
 * preferences down with them.
 */
export const userDrawings = pgTable('user_drawings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  drawings: jsonb('drawings').notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dailyAccountStats = pgTable(
  'daily_account_stats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tradeDate: date('trade_date').notNull(),
    startingBalanceMicros: micros('starting_balance_micros').notNull(),
    endingBalanceMicros: micros('ending_balance_micros').notNull(),
    realizedPnlMicros: micros('realized_pnl_micros').notNull().default(0),
    feesMicros: micros('fees_micros').notNull().default(0),
    highEquityMicros: micros('high_equity_micros').notNull(),
    lowEquityMicros: micros('low_equity_micros').notNull(),
    tradeCount: integer('trade_count').notNull().default(0),
    counted: boolean('counted').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [uniqueIndex('daily_stats_account_date_key').on(t.accountId, t.tradeDate)],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const accountEvents = pgTable(
  'account_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: varchar('type', { length: 40 }).notNull(),
    userId: uuid('user_id'),
    source: varchar('source', { length: 10 }).notNull(),
    request: jsonb('request'),
    prevState: jsonb('prev_state'),
    newState: jsonb('new_state'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('account_events_seq_key').on(t.accountId, t.seq),
    index('account_events_type_idx').on(t.accountId, t.type),
  ],
);

/**
 * The platform's audit record.
 *
 * Distinct from `account_events`, which is the engine's sequenced state stream
 * for WebSocket recovery. This one spans users, accounts, profiles and admin
 * actions, and it is APPEND-ONLY: a migration installs a trigger that raises on
 * UPDATE and DELETE, so ordinary application code cannot rewrite history even
 * by mistake.
 *
 * Each row also carries the hash of the previous row for its organisation, so a
 * row removed out of band breaks a chain that can be verified.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    /** USER | ADMIN | SYSTEM | SERVICE - what kind of actor did this. */
    actorType: varchar('actor_type', { length: 16 }).notNull(),
    actorUserId: uuid('actor_user_id'),
    /** A human-readable actor for the admin UI, captured at write time. */
    actorLabel: varchar('actor_label', { length: 120 }),
    /** ACCOUNT | USER | PROFILE | ORDER | ORGANIZATION. */
    subjectType: varchar('subject_type', { length: 24 }).notNull(),
    subjectId: uuid('subject_id'),
    accountId: uuid('account_id'),
    userId: uuid('user_id'),
    /** `account.reset`, `admin.account.locked`, `order.filled`, ... */
    action: varchar('action', { length: 60 }).notNull(),
    prevState: jsonb('prev_state'),
    newState: jsonb('new_state'),
    reason: text('reason'),
    context: jsonb('context'),
    requestId: varchar('request_id', { length: 64 }),
    ip: varchar('ip', { length: 64 }),
    /** Hash of the previous audit row for this organisation; null for the first. */
    prevHash: varchar('prev_hash', { length: 64 }),
    hash: varchar('hash', { length: 64 }).notNull(),
    createdAt: now(),
  },
  (t) => [
    index('audit_log_org_idx').on(t.organizationId, t.createdAt),
    index('audit_log_account_idx').on(t.accountId, t.createdAt),
    index('audit_log_user_idx').on(t.userId, t.createdAt),
    index('audit_log_action_idx').on(t.action, t.createdAt),
  ],
);

/**
 * The outbox.
 *
 * Something important happened; whoever cares can find out later. Payments,
 * e-mail, Discord, a CRM and a payout system all attach HERE, never inside the
 * matching engine - which is what keeps the execution path unaware of them.
 */
export const domainEvents = pgTable(
  'domain_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    /** `account.created`, `account.passed`, `order.filled`, ... */
    type: varchar('type', { length: 60 }).notNull(),
    accountId: uuid('account_id'),
    userId: uuid('user_id'),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Delivery bookkeeping for the subscriber that will exist later. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: now(),
  },
  (t) => [
    index('domain_events_type_idx').on(t.type, t.occurredAt),
    index('domain_events_undelivered_idx').on(t.deliveredAt, t.occurredAt),
    index('domain_events_account_idx').on(t.accountId, t.occurredAt),
  ],
);

/**
 * Provisioning idempotency.
 *
 * A purchase webhook that fires twice must not hand a customer two accounts.
 * The key is the caller's; the hash is of the request, so the same key with a
 * different body is a conflict rather than a silent second account.
 */
export const provisioningRequests = pgTable(
  'provisioning_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    idempotencyKey: varchar('idempotency_key', { length: 120 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    createdAt: now(),
  },
  (t) => [uniqueIndex('provisioning_requests_key').on(t.organizationId, t.idempotencyKey)],
);

/**
 * Machine credentials for the provisioning endpoint.
 *
 * Stored as a hash, like a refresh token: a leaked database row must not be a
 * usable key. This is the seam an external firm's purchase flow authenticates
 * with. No payment provider is implemented in this milestone.
 */
export const provisioningKeys = pgTable(
  'provisioning_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: varchar('name', { length: 80 }).notNull(),
    /** First characters of the key, so an admin can tell two keys apart. */
    prefix: varchar('prefix', { length: 16 }).notNull(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('provisioning_keys_hash_key').on(t.keyHash),
    index('provisioning_keys_org_idx').on(t.organizationId),
  ],
);

export const riskEvents = pgTable(
  'risk_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id'),
    rule: varchar('rule', { length: 48 }).notNull(),
    reasonCode: varchar('reason_code', { length: 40 }).notNull(),
    detail: jsonb('detail'),
    createdAt: now(),
  },
  (t) => [index('risk_events_account_idx').on(t.accountId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Workspace persistence — layouts, drawings, indicators, chart settings
// ---------------------------------------------------------------------------

export const layouts = pgTable(
  'layouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    config: jsonb('config').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [index('layouts_user_idx').on(t.userId)],
);

export const chartStates = pgTable(
  'chart_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    layoutId: uuid('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'cascade' }),
    chartId: varchar('chart_id', { length: 64 }).notNull(),
    symbol: varchar('symbol', { length: 12 }).notNull(),
    timeframe: varchar('timeframe', { length: 8 }).notNull(),
    chartType: varchar('chart_type', { length: 24 }).notNull().default('CANDLES'),
    linkGroup: varchar('link_group', { length: 16 }),
    settings: jsonb('settings').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('chart_states_layout_chart_key').on(t.layoutId, t.chartId)],
);

export const drawings = pgTable(
  'drawings',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    layoutId: uuid('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'cascade' }),
    chartId: varchar('chart_id', { length: 64 }).notNull(),
    symbol: varchar('symbol', { length: 12 }).notNull(),
    tool: varchar('tool', { length: 48 }).notNull(),
    points: jsonb('points').notNull(),
    style: jsonb('style').notNull().default({}),
    meta: jsonb('meta').notNull().default({}),
    zIndex: integer('z_index').notNull().default(0),
    locked: boolean('locked').notNull().default(false),
    hidden: boolean('hidden').notNull().default(false),
    timeframeVisibility: jsonb('timeframe_visibility'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [index('drawings_layout_chart_idx').on(t.layoutId, t.chartId)],
);

export const chartIndicators = pgTable(
  'chart_indicators',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    layoutId: uuid('layout_id')
      .notNull()
      .references(() => layouts.id, { onDelete: 'cascade' }),
    chartId: varchar('chart_id', { length: 64 }).notNull(),
    type: varchar('type', { length: 48 }).notNull(),
    inputs: jsonb('inputs').notNull().default({}),
    style: jsonb('style').notNull().default({}),
    pane: integer('pane').notNull().default(0),
    orderIndex: integer('order_index').notNull().default(0),
    visible: boolean('visible').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chart_indicators_layout_chart_idx').on(t.layoutId, t.chartId)],
);

// ---------------------------------------------------------------------------
// Market data provenance
// ---------------------------------------------------------------------------

export const marketDataMeta = pgTable(
  'market_data_meta',
  {
    symbol: varchar('symbol', { length: 12 }).primaryKey(),
    provider: varchar('provider', { length: 40 }).notNull(),
    mode: varchar('mode', { length: 12 }).notNull(),
    delaySeconds: integer('delay_seconds').notNull().default(0),
    /** Exchange timestamp of the newest event, NOT the server clock. */
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    depthLevels: integer('depth_levels').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/** Cached real historical bars, so a restart does not re-hit the vendor. */
export const historicalBars = pgTable(
  'historical_bars',
  {
    symbol: varchar('symbol', { length: 12 }).notNull(),
    timeframe: varchar('timeframe', { length: 8 }).notNull(),
    /** Bar open time as exchange epoch ms. */
    barTime: bigint('bar_time', { mode: 'number' }).notNull(),
    open: integer('open_ticks').notNull(),
    high: integer('high_ticks').notNull(),
    low: integer('low_ticks').notNull(),
    close: integer('close_ticks').notNull(),
    volume: bigint('volume', { mode: 'number' }).notNull().default(0),
    provider: varchar('provider', { length: 40 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('historical_bars_key').on(t.symbol, t.timeframe, t.barTime),
    index('historical_bars_scan_idx').on(t.symbol, t.timeframe, t.barTime),
  ],
);

/**
 * The operational account-state read model.
 *
 * A DERIVED, rebuildable snapshot of each account's authoritative financial
 * state - never a source of truth. It exists so owner and trader reads do not
 * recompute every account from scratch. Equity and unrealized P&L are NOT
 * stored: they depend on live marks and are applied at read time, so this table
 * never holds a stale valuation. `state_version` mirrors the account seq at the
 * moment it was projected; `consistent` goes false if a projection anomaly is
 * detected, which reconciliation resolves.
 */
export const accountProjections = pgTable(
  'account_projections',
  {
    accountId: uuid('account_id')
      .primaryKey()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /** Nullable, mirroring accounts.organization_id (legacy accounts may lack one). */
    organizationId: uuid('organization_id'),
    stateVersion: bigint('state_version', { mode: 'number' }).notNull(),
    status: varchar('status', { length: 20 }).notNull(),
    adminHold: varchar('admin_hold', { length: 20 }),
    ruleStatus: varchar('rule_status', { length: 20 }).notNull(),
    startingBalanceMicros: micros('starting_balance_micros').notNull(),
    balanceMicros: micros('balance_micros').notNull(),
    realizedPnlMicros: micros('realized_pnl_micros').notNull(),
    feesMicros: micros('fees_micros').notNull(),
    highWaterMarkMicros: micros('high_water_mark_micros').notNull(),
    drawdownFloorMicros: micros('drawdown_floor_micros').notNull(),
    openContracts: integer('open_contracts').notNull().default(0),
    workingOrderCount: integer('working_order_count').notNull().default(0),
    /** Open positions, enough to mark: {symbol, contractCode, side, qty, avgEntryTicks, costBasisMicros, marketEra}. */
    positions: jsonb('positions').notNull().default([]),
    lastFinancialMutationAt: timestamp('last_financial_mutation_at', { withTimezone: true }),
    projectionUpdatedAt: timestamp('projection_updated_at', { withTimezone: true }).notNull().defaultNow(),
    consistent: boolean('consistent').notNull().default(true),
  },
  (t) => [
    index('account_projections_org_idx').on(t.organizationId),
    index('account_projections_user_idx').on(t.userId),
    index('account_projections_open_idx').on(t.organizationId, t.openContracts),
  ],
);

/**
 * The transactional outbox the delivery worker drains.
 *
 * A financial mutation enqueues one row IN ITS OWN TRANSACTION, so a row exists
 * whenever the state change committed. The worker claims rows with FOR UPDATE
 * SKIP LOCKED, so multiple workers never own the same row. Delivery is
 * at-least-once; consumers are idempotent, so a redelivery has no duplicate
 * financial effect. `available_at` implements retry backoff; `dead_letter`
 * parks a row that exhausted its attempts.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateType: varchar('aggregate_type', { length: 20 }).notNull().default('ACCOUNT'),
    aggregateId: uuid('aggregate_id').notNull(),
    type: varchar('type', { length: 40 }).notNull(),
    stateVersion: bigint('state_version', { mode: 'number' }),
    payload: jsonb('payload'),
    createdAt: now(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    deadLetter: boolean('dead_letter').notNull().default(false),
  },
  (t) => [index('outbox_aggregate_idx').on(t.aggregateId)],
);
