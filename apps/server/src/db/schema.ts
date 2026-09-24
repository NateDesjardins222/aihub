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
    /**
     * Commercial lifecycle linkage (Commercial Account Lifecycle V1). All
     * nullable and additive: a practice or pre-lifecycle account carries none.
     *
     * `sourceQualificationId` / `sourceAccountId`: on a FUNDED_SIM account, the
     * qualification and evaluation account it was provisioned from. A funded
     * account never mutates its evaluation; it points back to it.
     * `fundedProfileVersionId`: on an EVALUATION account, the funded product
     * version pinned at acquisition, so a later owner change to the funded
     * product does not alter an already-sold evaluation's destination.
     */
    sourceQualificationId: uuid('source_qualification_id'),
    sourceAccountId: uuid('source_account_id'),
    fundedProfileVersionId: uuid('funded_profile_version_id').references(
      () => accountProfileVersions.id,
    ),
    /**
     * A trader's human-friendly label for this account ("NQ Account", "Morning
     * ES"). Presentation only: never affects accounting, audit, provisioning,
     * entitlements, trade ownership, or payout ownership. `publicId` stays
     * authoritative. (Customer Portal V1.)
     */
    nickname: varchar('nickname', { length: 60 }),
    /**
     * When this account was created by a RESET of a failed account, the account
     * it replaced. The failed account is preserved in history, never erased.
     * (Account Lifecycle UX V1.)
     */
    resetOfAccountId: uuid('reset_of_account_id'),
    /** Presentation preference only: a trader hid this terminal account from lists. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
// Commercial account lifecycle (Commercial Account Lifecycle V1)
//
// A provider-independent lifecycle: a commercial order (a purchase or an admin
// grant) creates an entitlement, which provisions exactly one account. When an
// evaluation passes, an immutable qualification is recorded and can produce
// exactly one funded-sim account. No real money moves here — a future payment
// provider is merely an authenticated trigger that completes a commercial order.
// ---------------------------------------------------------------------------

/**
 * A customer acquiring a product. NOT a payment: `amountMicros` is informational
 * and no money is moved. A future Stripe/Whop webhook, or an owner's admin
 * grant, creates and completes one of these; nothing downstream cares which.
 */
export const commercialOrders = pgTable(
  'commercial_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The product version being acquired (pins the terms at acquisition). */
    productVersionId: uuid('product_version_id')
      .notNull()
      .references(() => accountProfileVersions.id),
    /** How the order arose: ADMIN_GRANT | PURCHASE | PROMO | … */
    source: varchar('source', { length: 24 }).notNull(),
    /** The external system, when any (e.g. 'stripe'); null for an admin grant. */
    externalProvider: varchar('external_provider', { length: 40 }),
    /** The external system's reference (e.g. a Stripe session id). Opaque. */
    externalReference: varchar('external_reference', { length: 200 }),
    /**
     * PENDING | COMPLETED | PROVISIONED | PROVISION_BLOCKED | PROVISION_FAILED |
     * FAILED | CANCELLED | REFUNDED. COMPLETED means money settled server-side;
     * PROVISION_BLOCKED / PROVISION_FAILED are the recoverable "PAYMENT SUCCEEDED /
     * PROVISIONING FAILED" states — the money is retained, provisioning is deferred.
     */
    status: varchar('status', { length: 24 }).notNull().default('PENDING'),
    /** Informational only; Atlas processes no money this milestone. */
    amountMicros: micros('amount_micros'),
    currency: varchar('currency', { length: 8 }),
    /** Dedupe key: a webhook that fires twice completes one order, not two. */
    idempotencyKey: varchar('idempotency_key', { length: 200 }),
    /** Why provisioning is blocked/failed (gate reasons or the caught error). */
    provisionNote: text('provision_note'),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    refundReason: text('refund_reason'),
    createdAt: now(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('commercial_orders_org_idx').on(t.organizationId),
    index('commercial_orders_user_idx').on(t.userId),
    uniqueIndex('commercial_orders_idem_key').on(t.organizationId, t.idempotencyKey),
  ],
);

/**
 * The right, created by a completed order (or an admin grant), to receive ONE
 * account. Consuming it provisions exactly one account — the second guard,
 * alongside provisioning's own idempotency key, against duplicate accounts.
 */
export const entitlements = pgTable(
  'entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for a pure admin grant with no order behind it. */
    commercialOrderId: uuid('commercial_order_id').references(() => commercialOrders.id),
    productVersionId: uuid('product_version_id')
      .notNull()
      .references(() => accountProfileVersions.id),
    /** EVALUATION | RESET — what the entitlement lets the holder provision. */
    kind: varchar('kind', { length: 16 }).notNull(),
    source: varchar('source', { length: 24 }).notNull(),
    /** GRANTED | CONSUMED | REVOKED */
    status: varchar('status', { length: 16 }).notNull().default('GRANTED'),
    /** The account this entitlement provisioned. Set once, on consumption. */
    consumedByAccountId: uuid('consumed_by_account_id').references(() => accounts.id),
    createdAt: now(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    index('entitlements_org_idx').on(t.organizationId),
    index('entitlements_user_idx').on(t.userId),
    // One completed order yields one entitlement of a kind.
    uniqueIndex('entitlements_order_kind_key').on(t.commercialOrderId, t.kind),
  ],
);

/**
 * The immutable evidence that an evaluation qualified, plus the (separately
 * mutable) funding lifecycle that follows. One row per passed evaluation life
 * (`accountId, lifecycleId`), so certification happens exactly once.
 *
 * The evidence columns are written once at certification and never updated; only
 * the funding columns move (ELIGIBLE → FUNDING_PENDING → APPROVED/DECLINED →
 * FUNDED). A compensating transition, never a history rewrite, corrects a
 * mistake.
 */
export const accountQualifications = pgTable(
  'account_qualifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    lifecycleId: uuid('lifecycle_id').references(() => accountLifecycles.id),
    productVersionId: uuid('product_version_id').references(() => accountProfileVersions.id),
    /** Immutable: each requirement {key,label,required,actual,met} + summary. */
    evidence: jsonb('evidence').notNull(),
    balanceMicros: micros('balance_micros').notNull(),
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }).notNull().defaultNow(),
    /** Mutable funding lifecycle: ELIGIBLE|FUNDING_PENDING|APPROVED|DECLINED|FUNDED */
    fundingState: varchar('funding_state', { length: 20 }).notNull().default('ELIGIBLE'),
    /** The funded-sim account this qualification produced. Set once. */
    fundedAccountId: uuid('funded_account_id').references(() => accounts.id),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    declineReason: text('decline_reason'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('account_qualifications_life_key').on(t.accountId, t.lifecycleId),
    index('account_qualifications_org_state_idx').on(t.organizationId, t.fundingState),
  ],
);

/**
 * Internal staff notes about a trader (Owner Control Center V3).
 *
 * Operational, owner-side data — a trader NEVER sees these. Append-only: a note
 * is written once and, if it needs correcting, superseded by another note or
 * marked redacted, never silently overwritten, so the operational record cannot
 * be quietly rewritten. Every write is also audited.
 */
export const traderNotes = pgTable(
  'trader_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** The trader this note is about. */
    subjectUserId: uuid('subject_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** GENERAL | SUPPORT | RISK | ACCOUNT. */
    category: varchar('category', { length: 16 }).notNull().default('GENERAL'),
    body: text('body').notNull(),
    /** The staff member who wrote it, frozen at write time. */
    authorUserId: uuid('author_user_id').references(() => users.id),
    authorLabel: varchar('author_label', { length: 120 }),
    /** Append-only: a redacted note keeps its row but hides its body. */
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
    redactedByLabel: varchar('redacted_by_label', { length: 120 }),
    createdAt: now(),
  },
  (t) => [
    index('trader_notes_subject_idx').on(t.subjectUserId, t.createdAt),
    index('trader_notes_org_idx').on(t.organizationId, t.createdAt),
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
    /**
     * Set true the first time a fill of this order INCREASES exposure (M5).
     * Personal "max trades per day" counts an order once regardless of partial
     * fills, so the fill path flips this false→true exactly once and increments
     * the per-day opening-trade counter only on that transition.
     */
    openedExposure: boolean('opened_exposure').notNull().default(false),
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

// ---------------------------------------------------------------------------
// Happy Trader Funding — Payout Engine V1.
//
// The production-grade eligibility/state/accounting architecture that will one
// day govern real funded payouts. No money leaves the firm in V1: PROCESSING
// and PAID are operator/mock transitions. Every money term is pinned to the
// account's immutable product version (config.payoutRules); nothing is
// hard-coded. Mirrors the commercial lifecycle's idempotent-under-lock pattern.

/**
 * A Core/Select/Daily qualification cycle for a funded account.
 *
 * Core opens a fresh cycle after every approved payout (winning days reset).
 * Daily opens one cycle and, once its initial winning-days + buffer are met,
 * flips `dailyModeUnlocked` and never requires 5 winning days again.
 */
export const payoutCycles = pgTable(
  'payout_cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    model: varchar('model', { length: 8 }).notNull(),
    /** 1-based cycle number; drives the progressive request cap. */
    ordinal: integer('ordinal').notNull(),
    /** Winning-day window start (exclusive). Days on/before this do not count. */
    startedOn: date('started_on'),
    /** DAILY: buffer + initial winning days established, payouts unlocked. */
    dailyModeUnlocked: boolean('daily_mode_unlocked').notNull().default(false),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('payout_cycles_account_ordinal').on(t.accountId, t.ordinal),
    index('payout_cycles_org_idx').on(t.organizationId),
  ],
);

/**
 * One payout request and its state-machine position.
 *
 * The balance is debited exactly once, at APPROVED; the ledger DEBIT is the
 * proof. `version` is a CAS guard so two operators approving at once cannot both
 * act. `idempotencyKey` makes a duplicate request (refresh, retry) a no-op.
 */
export const payoutRequests = pgTable(
  'payout_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The product version whose payoutRules governed this request. */
    productVersionId: uuid('product_version_id').references(() => accountProfileVersions.id),
    cycleId: uuid('cycle_id').references(() => payoutCycles.id),
    state: varchar('state', { length: 20 }).notNull().default('REQUESTED'),
    requestedGrossMicros: micros('requested_gross_micros').notNull(),
    grossEligibleMicros: micros('gross_eligible_micros'),
    traderShareMicros: micros('trader_share_micros'),
    firmShareMicros: micros('firm_share_micros'),
    feesMicros: micros('fees_micros').notNull().default(0),
    balanceAdjustmentMicros: micros('balance_adjustment_micros'),
    protectedBufferMicros: micros('protected_buffer_micros'),
    withdrawableBeforeMicros: micros('withdrawable_before_micros'),
    /**
     * Milestone 6: the authoritative qualifying account balance (pre-debit)
     * snapshotted at APPROVED. Drives the DAILY progressive-balance rule for the
     * next payout. Null until approved.
     */
    qualifyingBalanceAtApproval: micros('qualifying_balance_at_approval'),
    /** Reason codes + winning days + best day + consistency at request time. */
    eligibilitySnapshot: jsonb('eligibility_snapshot'),
    /** 1-based ordinal within the account's payouts; drives progressive caps. */
    payoutOrdinal: integer('payout_ordinal').notNull().default(1),
    /** RISK | FRAUD | MANUAL, null when none. */
    holdKind: varchar('hold_kind', { length: 16 }),
    reason: text('reason'),
    idempotencyKey: varchar('idempotency_key', { length: 200 }),
    version: integer('version').notNull().default(0),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('payout_requests_idem_key').on(t.organizationId, t.idempotencyKey),
    index('payout_requests_org_state_idx').on(t.organizationId, t.state),
    index('payout_requests_account_idx').on(t.accountId),
  ],
);

/**
 * The append-only payout ledger. Never updated or deleted (a trigger enforces
 * it). One row per money event: the DEBIT at approval, an optional REVERSAL if a
 * later step fails, and the SETTLEMENT when marked paid. Given a request id the
 * whole accounting is reconstructable. Trades are never touched to make a payout.
 */
export const payoutLedger = pgTable(
  'payout_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    payoutRequestId: uuid('payout_request_id')
      .notNull()
      .references(() => payoutRequests.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    entryType: varchar('entry_type', { length: 16 }).notNull(),
    amountMicros: micros('amount_micros').notNull(),
    balanceBeforeMicros: micros('balance_before_micros').notNull(),
    balanceAfterMicros: micros('balance_after_micros').notNull(),
    grossEligibleMicros: micros('gross_eligible_micros'),
    traderShareMicros: micros('trader_share_micros'),
    firmShareMicros: micros('firm_share_micros'),
    protectedBufferMicros: micros('protected_buffer_micros'),
    productVersionId: uuid('product_version_id').references(() => accountProfileVersions.id),
    meta: jsonb('meta'),
    createdAt: now(),
  },
  (t) => [
    // The debit/settlement of a request happens at most once — this is the
    // structural guard that a duplicate approval or webhook cannot double-move.
    uniqueIndex('payout_ledger_request_entry').on(t.payoutRequestId, t.entryType),
    index('payout_ledger_account_idx').on(t.accountId),
    index('payout_ledger_org_idx').on(t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Economics Simulator V1 — owner-only, synthetic. No FKs to trader/account
// data; a run is a pure computation cached for the owner. Deleting all of these
// changes nothing in production.

export const economicsScenarios = pgTable(
  'economics_scenarios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: varchar('name', { length: 120 }).notNull(),
    baseScenario: varchar('base_scenario', { length: 40 }),
    assumptions: jsonb('assumptions').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('economics_scenarios_org_idx').on(t.organizationId)],
);

export const economicsRuns = pgTable(
  'economics_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    scenarioId: uuid('scenario_id').references(() => economicsScenarios.id),
    seed: bigint('seed', { mode: 'number' }).notNull(),
    purchases: integer('purchases').notNull(),
    /** The assumption set frozen at run time, so the result is reproducible. */
    assumptions: jsonb('assumptions').notNull(),
    /** Aggregates + per product/size + sensitivity + Monte Carlo distributions. */
    results: jsonb('results').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: now(),
  },
  (t) => [index('economics_runs_org_idx').on(t.organizationId)],
);

// ---------------------------------------------------------------------------
// Happy Trader Funding — Customer Identity + Commerce Provisioning V1.
//
// "Email is not the person." A permanent customer_identities row is the spine
// every commercial/KYC/agreement fact hangs from; it sits beside `users` (the
// auth principal), never replacing it. Contact verification, identity
// verification, and versioned agreement acceptance gate an ungated purchase
// from provisioning. See docs/customer-identity-v1.md.
//
// No real KYC/commerce/notification provider is wired: the mock/local adapters
// are the working default and are never presented as production integrations.

/**
 * The permanent human customer. One per auth principal in V1 (unique user_id).
 * `identity_status` is the denormalised current verification state, kept in step
 * with the latest identity_verifications row under the identity's advisory lock.
 * Never stores document images, SSN/TIN, or raw provider payloads.
 */
export const customerIdentities = pgTable(
  'customer_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ACTIVE | HOLD | CLOSED — operational, NOT a verification state. */
    status: varchar('status', { length: 24 }).notNull().default('ACTIVE'),
    legalName: text('legal_name'),
    dateOfBirth: date('date_of_birth'),
    /** Informational; NO country eligibility list is enforced in V1. */
    country: varchar('country', { length: 2 }),
    /** UNVERIFIED|CONTACT_PENDING|CONTACT_VERIFIED|IDENTITY_PENDING|STEP_UP_REQUIRED|UNDER_REVIEW|IDENTITY_VERIFIED|REJECTED */
    identityStatus: varchar('identity_status', { length: 24 }).notNull().default('UNVERIFIED'),
    /** The SAFE public name shown on shared certificates (never the legal name). */
    preferredDisplayName: varchar('preferred_display_name', { length: 80 }),
    /** Global opt-in for public achievement display. Default off (private). */
    achievementsPublic: boolean('achievements_public').notNull().default(false),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_identities_user_key').on(t.userId),
    index('customer_identities_org_idx').on(t.organizationId),
    index('customer_identities_org_status_idx').on(t.organizationId, t.identityStatus),
  ],
);

/**
 * A proven reachable channel. A person may have several; at most one primary per
 * channel (a partial unique index enforces it). Verified contact is NOT identity.
 */
export const verifiedContacts = pgTable(
  'verified_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    /** EMAIL | SMS */
    channel: varchar('channel', { length: 8 }).notNull(),
    /** Normalised: email lowercased, phone E.164. */
    value: varchar('value', { length: 254 }).notNull(),
    /** PENDING | VERIFIED | REVOKED */
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),
    isPrimary: boolean('is_primary').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('verified_contacts_identity_channel_value_key').on(
      t.customerIdentityId,
      t.channel,
      t.value,
    ),
    index('verified_contacts_identity_idx').on(t.customerIdentityId),
  ],
);

/**
 * The short-lived proof-of-contact challenge. The plaintext code is NEVER stored
 * (only a salted hash) and NEVER returned in a production response. Attempt-capped
 * and TTL'd; a new challenge for the same target voids the prior live one.
 */
export const contactVerificationChallenges = pgTable(
  'contact_verification_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 8 }).notNull(),
    value: varchar('value', { length: 254 }).notNull(),
    codeHash: text('code_hash').notNull(),
    salt: text('salt').notNull(),
    /** PENDING | CONSUMED | EXPIRED | VOID */
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    index('contact_challenges_identity_idx').on(t.customerIdentityId, t.channel, t.status),
  ],
);

/**
 * A KYC verification attempt. Stores the DECISION and provider reference, never
 * the documents. The latest terminal row drives customer_identities.identity_status.
 * `provider` records which adapter produced it (MOCK | STRIPE) so a mock decision
 * is never mistaken for a production one.
 */
export const identityVerifications = pgTable(
  'identity_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    /** MOCK | STRIPE */
    provider: varchar('provider', { length: 24 }).notNull(),
    providerRef: varchar('provider_ref', { length: 200 }),
    /** UNVERIFIED|IDENTITY_PENDING|STEP_UP_REQUIRED|UNDER_REVIEW|IDENTITY_VERIFIED|REJECTED */
    status: varchar('status', { length: 24 }).notNull(),
    /** Coarse reason (DOCUMENT_UNREADABLE|NAME_MISMATCH|STEP_UP|MANUAL_DECLINE); never a raw provider blob. */
    reasonCode: varchar('reason_code', { length: 48 }),
    legalName: text('legal_name'),
    dateOfBirth: date('date_of_birth'),
    /** Structured address; NO document images. */
    addressJson: jsonb('address_json'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('identity_verifications_identity_idx').on(t.customerIdentityId, t.status),
    index('identity_verifications_org_status_idx').on(t.organizationId, t.status),
    index('identity_verifications_provider_ref_idx').on(t.provider, t.providerRef),
  ],
);

/**
 * A versioned agreement. Append-only (a trigger rejects UPDATE/DELETE): a material
 * change publishes a NEW version, never edits an old one. Body is clearly-labelled
 * DEV PLACEHOLDER content in V1 — not counsel-approved. `content_hash` is the
 * immutable identifier of exactly what was shown.
 */
export const agreementVersions = pgTable(
  'agreement_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** TERMS_OF_USE | TRADER_PLEDGE | PRIVACY | RISK_DISCLOSURE */
    agreementType: varchar('agreement_type', { length: 32 }).notNull(),
    version: integer('version').notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    body: text('body').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    isRequired: boolean('is_required').notNull().default(true),
    requiresReacceptance: boolean('requires_reacceptance').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('agreement_versions_type_version_key').on(
      t.organizationId,
      t.agreementType,
      t.version,
    ),
    uniqueIndex('agreement_versions_type_hash_key').on(
      t.organizationId,
      t.agreementType,
      t.contentHash,
    ),
  ],
);

/**
 * The immutable acceptance record. Append-only (a trigger rejects UPDATE/DELETE):
 * a prior acceptance is NEVER overwritten. Unique per (identity, version), so a
 * double-submit is a no-op. `content_hash` is copied at acceptance — the exact
 * thing agreed to.
 */
export const agreementAcceptances = pgTable(
  'agreement_acceptances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    agreementVersionId: uuid('agreement_version_id')
      .notNull()
      .references(() => agreementVersions.id),
    agreementType: varchar('agreement_type', { length: 32 }).notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Security metadata: ip, user-agent, product_version context. */
    sessionMeta: jsonb('session_meta'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('agreement_acceptances_identity_version_key').on(
      t.customerIdentityId,
      t.agreementVersionId,
    ),
    index('agreement_acceptances_identity_idx').on(t.customerIdentityId),
  ],
);

/**
 * The commerce event ledger: authenticity, uniqueness, replay, and audit for
 * every inbound provider event. Unique (provider, provider_event_id) is the
 * structural dedup — a replayed webhook is dropped before any provisioning work.
 * A rejected/failed event is RECORDED, never silently dropped (reconciliation).
 */
export const commerceEvents = pgTable(
  'commerce_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** MOCK | WHOP */
    provider: varchar('provider', { length: 16 }).notNull(),
    providerEventId: varchar('provider_event_id', { length: 200 }).notNull(),
    /** PAYMENT_SUCCEEDED|PAYMENT_FAILED|REFUND|DISPUTE_OPENED|DISPUTE_CLOSED|UNKNOWN */
    kind: varchar('kind', { length: 24 }).notNull(),
    atlasOrderId: uuid('atlas_order_id').references(() => commercialOrders.id),
    /** RECEIVED | PROCESSED | IGNORED | REJECTED | FAILED */
    status: varchar('status', { length: 16 }).notNull().default('RECEIVED'),
    signatureOk: boolean('signature_ok').notNull().default(false),
    /** BAD_SIGNATURE|STALE|MALFORMED|UNKNOWN_ORDER|UNKNOWN_PRODUCT|PRICE_MISMATCH */
    rejectReason: varchar('reject_reason', { length: 48 }),
    /** sha256 of the raw body; NO secrets. */
    payloadDigest: varchar('payload_digest', { length: 64 }),
    amountMicros: micros('amount_micros'),
    currency: varchar('currency', { length: 8 }),
    providerCustomerId: varchar('provider_customer_id', { length: 200 }),
    receiptId: varchar('receipt_id', { length: 200 }),
    lastError: varchar('last_error', { length: 200 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('commerce_events_provider_event_key').on(t.provider, t.providerEventId),
    index('commerce_events_org_status_idx').on(t.organizationId, t.status),
    index('commerce_events_order_idx').on(t.atlasOrderId),
  ],
);

/**
 * One logical customer notification. Unique (organization_id, dedupe_key) is the
 * at-most-once guard: a retried event never sends "FUNDED READY" seventeen times.
 * An unconfigured provider yields a visible SUPPRESSED row, never a fake SENT.
 * Strictly downstream of the authoritative transaction — see docs/notifications-v1.md.
 */
export const notificationMessages = pgTable(
  'notification_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    customerIdentityId: uuid('customer_identity_id').references(() => customerIdentities.id, {
      onDelete: 'cascade',
    }),
    /** One of the ~19 notification types (see docs/notifications-v1.md §5). */
    type: varchar('type', { length: 40 }).notNull(),
    /** EMAIL | SMS */
    channel: varchar('channel', { length: 8 }).notNull(),
    recipient: varchar('recipient', { length: 254 }).notNull(),
    templateVersion: varchar('template_version', { length: 24 }).notNull().default('v1'),
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    /** PENDING | SENT | FAILED | SUPPRESSED */
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),
    terminal: boolean('terminal').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(6),
    /** MOCK | RESEND | TWILIO */
    provider: varchar('provider', { length: 16 }),
    providerRef: varchar('provider_ref', { length: 200 }),
    lastError: varchar('last_error', { length: 200 }),
    payload: jsonb('payload'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_messages_dedupe_key').on(t.organizationId, t.dedupeKey),
    index('notification_messages_status_idx').on(t.status, t.channel),
    index('notification_messages_identity_idx').on(t.customerIdentityId),
  ],
);

// ---------------------------------------------------------------------------
// Happy Trader Funding — Certificates & Achievements V1.
//
// Event-driven, idempotent, privacy-controlled recognition. A certificate is
// publicly verifiable at /verify/<token> exposing only safe data; achievements
// are restrained (no game economy) with per-trader visibility. Issuance is
// exactly-once per triggering event via a unique dedupe_key. See
// docs/certificates-achievements-v1.md.

export const certificates = pgTable(
  'certificates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** HT-C-XXXX — the immutable public certificate id. */
    certificatePublicId: varchar('certificate_public_id', { length: 24 }).notNull(),
    /** Random URL-safe slug for the public /verify/<token> route (QR-compatible). */
    verificationToken: varchar('verification_token', { length: 48 }).notNull(),
    /**
     * EVALUATION_PASSED | FUNDED_TRADER | PAYOUT | ACCOUNT_COMPLETED |
     * TENK_CLUB | FIFTYK_CLUB | HUNDREDK_CLUB (Milestone 6 clubs).
     */
    type: varchar('type', { length: 24 }).notNull(),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    // A certificate is earned recognition: if an account row is ever removed, the
    // certificate survives with a null account reference (never un-earned).
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** A SAFE public name (e.g. "Nathan D."). Never the legal full name. */
    publicDisplayName: varchar('public_display_name', { length: 80 }).notNull(),
    amountMicros: micros('amount_micros'),
    /** ISSUED | REVOKED */
    status: varchar('status', { length: 16 }).notNull().default('ISSUED'),
    revokedReason: text('revoked_reason'),
    templateVersion: varchar('template_version', { length: 24 }).notNull().default('v1'),
    // ---- Milestone 6: deterministic rendered artifact + storage (frozen at issuance) ----
    /** The renderer implementation version, frozen onto the certificate. */
    rendererVersion: varchar('renderer_version', { length: 24 }),
    /** PENDING | RENDERED | FAILED | DISABLED (no approved master for this type). */
    renderStatus: varchar('render_status', { length: 16 }).notNull().default('PENDING'),
    /** Object-store keys for the immutable artifacts (never disk paths). */
    imageStorageKey: text('image_storage_key'),
    printStorageKey: text('print_storage_key'),
    pdfStorageKey: text('pdf_storage_key'),
    /** sha256 over the print artifact + frozen versions — the structural proof. */
    renderHash: varchar('render_hash', { length: 64 }),
    /** Safe last render error (no secrets), when renderStatus = FAILED. */
    renderError: text('render_error'),
    /** The LOCKED milestone label value for club certificates ($10k/$50k/$100k). */
    milestoneValueMicros: micros('milestone_value_micros'),
    /** Exactly-once per triggering event. */
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('certificates_dedupe_key').on(t.organizationId, t.dedupeKey),
    uniqueIndex('certificates_token_key').on(t.verificationToken),
    uniqueIndex('certificates_public_id_key').on(t.certificatePublicId),
    index('certificates_identity_idx').on(t.customerIdentityId),
  ],
);

/**
 * Milestone 6 — per-certificate reward delivery tracking (in-app + email). A
 * delivery failure never rolls back issuance; delivery retries asynchronously.
 */
export const rewardDelivery = pgTable(
  'reward_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    certificateId: uuid('certificate_id')
      .notNull()
      .references(() => certificates.id, { onDelete: 'cascade' }),
    inAppDeliveredAt: timestamp('in_app_delivered_at', { withTimezone: true }),
    emailQueuedAt: timestamp('email_queued_at', { withTimezone: true }),
    emailDeliveredAt: timestamp('email_delivered_at', { withTimezone: true }),
    lastDeliveryError: text('last_delivery_error'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reward_delivery_certificate_key').on(t.certificateId)],
);

/**
 * Milestone 6 — the 100K plaque, and any future manual physical reward. NEVER
 * routed to a fulfillment provider: manual owner fulfillment only, no automatic
 * spending. One per (customer, type).
 */
export const physicalRewardFulfillment = pgTable(
  'physical_reward_fulfillment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    certificateId: uuid('certificate_id').references(() => certificates.id, { onDelete: 'set null' }),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    /** PLAQUE_100K */
    type: varchar('type', { length: 24 }).notNull(),
    /** PENDING_REVIEW | VERIFIED | ORDERED | SHIPPED | DELIVERED | CANCELLED | HOLD */
    status: varchar('status', { length: 24 }).notNull().default('PENDING_REVIEW'),
    /** NOT_PROVIDED | PROVIDED | CONFIRMED */
    shippingAddressStatus: varchar('shipping_address_status', { length: 24 }).notNull().default('NOT_PROVIDED'),
    fulfillmentNotes: text('fulfillment_notes'),
    trackingCarrier: varchar('tracking_carrier', { length: 48 }),
    trackingNumber: varchar('tracking_number', { length: 120 }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('physical_reward_customer_type_key').on(t.organizationId, t.customerIdentityId, t.type),
    index('physical_reward_status_idx').on(t.organizationId, t.status),
  ],
);

export const achievements = pgTable(
  'achievements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    /** FUNDED | FIRST_PAYOUT | PAID_5K | PAID_10K | PAID_25K | FIVE_PAYOUT_CLUB | ACCOUNT_COMPLETED */
    type: varchar('type', { length: 32 }).notNull(),
    /** Exactly-once per (identity, milestone). */
    dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    meta: jsonb('meta'),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('achievements_dedupe_key').on(t.organizationId, t.dedupeKey),
    index('achievements_identity_idx').on(t.customerIdentityId),
  ],
);

// ---------------------------------------------------------------------------
// Native copy trading (Atlas Native Copy Trading V1)
// ---------------------------------------------------------------------------

/**
 * A copy group: one leader account and up to four follower accounts, ALL owned
 * by the same verified Happy Trader customer identity. The group orchestrates
 * the existing execution/risk pipeline; it never holds money or trading
 * authority. See docs/copy-trading-v1.md.
 */
export const copyGroups = pgTable(
  'copy_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    customerIdentityId: uuid('customer_identity_id')
      .notNull()
      .references(() => customerIdentities.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    /** The current leader; nullable when the leader was lost (group PAUSED). */
    leaderAccountId: uuid('leader_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** SAME | MULTIPLIER | FIXED — the group default sizing mode. */
    sizingMode: varchar('sizing_mode', { length: 16 }).notNull().default('SAME'),
    /** ACTIVE | PAUSED | DISABLED */
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
    /** Optimistic concurrency on config edits. */
    version: integer('version').notNull().default(0),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('copy_groups_identity_idx').on(t.customerIdentityId),
    index('copy_groups_user_idx').on(t.userId),
    index('copy_groups_leader_idx').on(t.leaderAccountId),
    // An account leads at most one non-disabled group (loop/chain prevention).
    uniqueIndex('copy_groups_active_leader_key')
      .on(t.leaderAccountId)
      .where(sql`status <> 'DISABLED' and leader_account_id is not null`),
  ],
);

export const copyFollowers = pgTable(
  'copy_followers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    copyGroupId: uuid('copy_group_id')
      .notNull()
      .references(() => copyGroups.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    /** MULTIPLIER mode: the multiplier in THOUSANDTHS (0.5 → 500). Integer math. */
    sizingMultiplierMilli: integer('sizing_multiplier_milli'),
    /** FIXED mode: the fixed contract quantity this follower attempts. */
    sizingFixedQty: integer('sizing_fixed_qty'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('copy_followers_group_account_key').on(t.copyGroupId, t.accountId),
    index('copy_followers_account_idx').on(t.accountId),
  ],
);

/**
 * One immutable logical copy action (leader BUY/SELL/modify/cancel/flatten). Its
 * idempotency key, unique per group, is the exactly-once identity: a retried,
 * double-clicked or replayed action converges to ONE intent.
 */
export const copyIntents = pgTable(
  'copy_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    copyGroupId: uuid('copy_group_id')
      .notNull()
      .references(() => copyGroups.id, { onDelete: 'cascade' }),
    leaderAccountId: uuid('leader_account_id').notNull(),
    /** SUBMIT | MODIFY | CANCEL | FLATTEN */
    kind: varchar('kind', { length: 12 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 120 }).notNull(),
    symbol: varchar('symbol', { length: 12 }),
    side: varchar('side', { length: 4 }),
    qty: integer('qty'),
    orderType: varchar('order_type', { length: 16 }),
    limitTicks: integer('limit_ticks'),
    stopTicks: integer('stop_ticks'),
    bracketConfig: jsonb('bracket_config'),
    /** The leader's resulting order (for MODIFY/CANCEL correlation). */
    leaderOrderId: uuid('leader_order_id'),
    /** PENDING | FANNED_OUT | COMPLETE (bookkeeping; children hold outcomes). */
    state: varchar('state', { length: 16 }).notNull().default('PENDING'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('copy_intents_group_idem_key').on(t.copyGroupId, t.idempotencyKey),
    index('copy_intents_group_idx').on(t.copyGroupId, t.createdAt),
  ],
);

/**
 * One account's slice of a copy intent. `order_id` references the authoritative
 * `orders` row once placed; this row is orchestration metadata and never carries
 * money. Unique per (intent, account) — the per-account exactly-once backstop.
 */
export const copyChildren = pgTable(
  'copy_children',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    copyIntentId: uuid('copy_intent_id')
      .notNull()
      .references(() => copyIntents.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** LEADER | FOLLOWER */
    role: varchar('role', { length: 8 }).notNull(),
    requestedQty: integer('requested_qty').notNull().default(0),
    sizingNote: varchar('sizing_note', { length: 200 }),
    /** PENDING | ACCEPTED | REJECTED | SKIPPED */
    status: varchar('status', { length: 12 }).notNull().default('PENDING'),
    /** The authoritative order this child produced, if any. */
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    rejectCode: varchar('reject_code', { length: 48 }),
    rejectMessage: text('reject_message'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('copy_children_intent_account_key').on(t.copyIntentId, t.accountId),
    index('copy_children_account_idx').on(t.accountId),
    index('copy_children_order_idx').on(t.orderId),
  ],
);

// ---------------------------------------------------------------------------
// Production trading infrastructure (Milestone 4). Additive; simulation default.
// ---------------------------------------------------------------------------

/**
 * How an Atlas account's orders are executed (M4-P). Default is SIMULATION; an
 * EXTERNAL_* mapping requires explicit server-side administrative action — a
 * customer can never self-promote. Copy trading operates on Atlas account ids
 * regardless of the provider behind each account.
 */
export const providerAccountMappings = pgTable(
  'provider_account_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** SIMULATION | EXTERNAL_PAPER | EXTERNAL_LIVE */
    executionMode: varchar('execution_mode', { length: 20 }).notNull().default('SIMULATION'),
    /** simulation | rithmic | scripted */
    executionProvider: varchar('execution_provider', { length: 20 }).notNull().default('simulation'),
    /** Opaque provider environment label (e.g. "paper", "prod"). */
    providerEnvironment: varchar('provider_environment', { length: 40 }),
    /** The provider's own account id. Never authoritative to the browser. */
    providerAccountId: varchar('provider_account_id', { length: 120 }),
    /** ACTIVE | SUSPENDED */
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),
    mappedAt: timestamp('mapped_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One mapping per account (the account's current execution routing).
    uniqueIndex('provider_account_mappings_account_key').on(t.accountId),
    index('provider_account_mappings_mode_idx').on(t.executionMode),
  ],
);

/**
 * The lifecycle of an order Atlas sent to an EXTERNAL venue (M4-N). Atlas ids are
 * canonical; the provider order id is stored separately and is never authority to
 * the browser. `idempotency_key` (the client order id) is unique so a retried
 * command cannot create a second external order. `avg_fill_price` is a provider-
 * reported reference price (real), NOT an Atlas money figure (those stay micros).
 */
export const externalOrders = pgTable(
  'external_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Atlas canonical order id (the only authority exposed to clients). */
    atlasOrderId: uuid('atlas_order_id').notNull(),
    /** The venue's order id; null until acknowledged. */
    providerOrderId: varchar('provider_order_id', { length: 120 }),
    providerAccountId: varchar('provider_account_id', { length: 120 }),
    symbol: varchar('symbol', { length: 12 }).notNull(),
    contractCode: varchar('contract_code', { length: 24 }),
    side: varchar('side', { length: 4 }).notNull(),
    orderType: varchar('order_type', { length: 16 }).notNull(),
    requestedQty: integer('requested_qty').notNull(),
    filledQty: integer('filled_qty').notNull().default(0),
    avgFillPrice: real('avg_fill_price'),
    /** ExternalOrderState */
    state: varchar('state', { length: 20 }).notNull().default('PENDING_SUBMIT'),
    /** The provider's own raw status string, kept for diagnosis. */
    providerStatus: varchar('provider_status', { length: 60 }),
    /** Client order id — idempotency key; a retry with this key never re-orders. */
    idempotencyKey: varchar('idempotency_key', { length: 120 }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_orders_idempotency_key').on(t.idempotencyKey),
    index('external_orders_account_idx').on(t.accountId),
    index('external_orders_atlas_order_idx').on(t.atlasOrderId),
    index('external_orders_provider_order_idx').on(t.providerOrderId),
    index('external_orders_state_idx').on(t.state),
  ],
);

/** Append-only audit of external execution reports (M4-N). `dedupe_key` unique
 * suppresses duplicate venue reports. */
export const externalExecutionEvents = pgTable(
  'external_execution_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    externalOrderId: uuid('external_order_id')
      .notNull()
      .references(() => externalOrders.id, { onDelete: 'cascade' }),
    providerOrderId: varchar('provider_order_id', { length: 120 }),
    state: varchar('state', { length: 20 }).notNull(),
    filledQty: integer('filled_qty').notNull().default(0),
    lastFillQty: integer('last_fill_qty').notNull().default(0),
    avgFillPrice: real('avg_fill_price'),
    providerStatus: varchar('provider_status', { length: 60 }),
    eventTs: timestamp('event_ts', { withTimezone: true }).notNull(),
    /** Optional idempotency for duplicate-report suppression. */
    dedupeKey: varchar('dedupe_key', { length: 160 }),
    createdAt: now(),
  },
  (t) => [
    index('external_execution_events_order_idx').on(t.externalOrderId),
    uniqueIndex('external_execution_events_dedupe_key').on(t.dedupeKey).where(sql`dedupe_key is not null`),
  ],
);

/** Reconciliation status per account against an external venue (M4-O). */
export const reconciliationState = pgTable(
  'reconciliation_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    providerAccountId: varchar('provider_account_id', { length: 120 }),
    /** IN_SYNC | RECONCILIATION_REQUIRED | UNKNOWN */
    state: varchar('state', { length: 30 }).notNull().default('IN_SYNC'),
    detail: text('detail'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reconciliation_state_account_key').on(t.accountId)],
);

/** Market-data entitlement domain (M4-S). SOFTWARE domain only — not an exchange
 * agreement, not legal permission to redistribute. */
export const marketDataEntitlements = pgTable(
  'market_data_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** Null for a provider/exchange-wide entitlement; set for a specific user. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** CME | CBOT | NYMEX | COMEX */
    exchange: varchar('exchange', { length: 12 }).notNull(),
    /** DELAYED | REALTIME_TOP | REALTIME_DEPTH */
    dataLevel: varchar('data_level', { length: 20 }).notNull(),
    /** DISPLAY | NON_DISPLAY */
    displayUse: varchar('display_use', { length: 16 }).notNull().default('DISPLAY'),
    /** ENTITLED | NOT_ENTITLED | PENDING | UNKNOWN */
    status: varchar('status', { length: 16 }).notNull().default('UNKNOWN'),
    providerEntitlementRef: varchar('provider_entitlement_ref', { length: 120 }),
    effectiveAt: timestamp('effective_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('market_data_entitlements_user_idx').on(t.userId),
    index('market_data_entitlements_exchange_idx').on(t.exchange),
  ],
);

/** Coarse, bounded provider operational events (M4-T). NEVER market ticks and
 * NEVER a credential — connect/disconnect/reconnect/degraded/error lifecycle. */
export const providerOpsEvents = pgTable(
  'provider_ops_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: varchar('provider_id', { length: 40 }).notNull(),
    /** MARKET_DATA | EXECUTION */
    role: varchar('role', { length: 16 }).notNull(),
    /** connect | disconnect | reconnect | degraded | error | ... */
    kind: varchar('kind', { length: 40 }).notNull(),
    /** Redacted, secret-free detail. */
    detail: text('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: now(),
  },
  (t) => [
    index('provider_ops_events_provider_idx').on(t.providerId),
    index('provider_ops_events_occurred_idx').on(t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// Trader Personal Risk Controls (Milestone 5)
//
// A trader-configured, server-authoritative risk-control system that can only
// make an account MORE restrictive than firm rules. Account- and owner-scoped;
// changes are versioned (optimistic concurrency) and audited; per-trading-day
// usage counters are maintained on the fill path so the order-path gate reads
// them cheaply. Firm rules always win — nothing here loosens a firm limit.
// ---------------------------------------------------------------------------

/** One personal control per (account, controlType). */
export const traderRiskControls = pgTable(
  'trader_risk_controls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** DAILY_LOSS_LIMIT | MAX_TRADES | DAILY_DRAWDOWN | MAX_POSITION | ... */
    controlType: varchar('control_type', { length: 32 }).notNull(),
    /** The switch. Typing a value never enables a control; this must be true. */
    enabled: boolean('enabled').notNull().default(false),
    /** FLEXIBLE | LOCKED. LOCKED = tighten-only until the next trading day. */
    mode: varchar('mode', { length: 12 }).notNull().default('FLEXIBLE'),
    /** Currency magnitude (MICROS controls), always positive. */
    valueMicros: micros('value_micros'),
    /** Integer magnitude (INT controls): trades/contracts/losses/minutes. */
    valueInt: integer('value_int'),
    /** HH:MM exchange-tz bounds (TRADING_WINDOW). */
    windowStart: varchar('window_start', { length: 5 }),
    windowEnd: varchar('window_end', { length: 5 }),
    /** Allowed session keys (SESSION_RESTRICTION). */
    sessionsJson: jsonb('sessions_json'),
    /** When LOCKED was entered, and the trading day it was locked on. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedTradingDay: date('locked_trading_day'),
    /** Optimistic concurrency: a stale concurrent edit is rejected. */
    version: integer('version').notNull().default(0),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('trader_risk_controls_account_type_key').on(t.accountId, t.controlType),
    index('trader_risk_controls_account_idx').on(t.accountId),
  ],
);

/** Append-only audit of every personal-control change. */
export const traderRiskControlEvents = pgTable(
  'trader_risk_control_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    controlType: varchar('control_type', { length: 32 }).notNull(),
    /** created | updated | enabled | disabled | locked | tightened | expired */
    action: varchar('action', { length: 24 }).notNull(),
    oldState: jsonb('old_state'),
    newState: jsonb('new_state'),
    mode: varchar('mode', { length: 12 }),
    effectiveTradingDay: date('effective_trading_day'),
    actorUserId: uuid('actor_user_id'),
    /** TRADER | OWNER | SYSTEM */
    source: varchar('source', { length: 12 }).notNull().default('TRADER'),
    createdAt: now(),
  },
  (t) => [
    index('trader_risk_control_events_account_idx').on(t.accountId, t.createdAt),
  ],
);

/**
 * Running per-(account, tradeDate) counters, maintained on the fill path so the
 * order-path gate reads them cheaply. A new trading day is a new row, so
 * counters reset intrinsically at the authoritative day rollover.
 */
export const traderRiskDayState = pgTable(
  'trader_risk_day_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tradeDate: date('trade_date').notNull(),
    /** Opening trades today (one per originating order that opened exposure). */
    openingTradeCount: integer('opening_trade_count').notNull().default(0),
    /** Filled opening/increasing contracts today. */
    contractsOpened: integer('contracts_opened').notNull().default(0),
    /** Current consecutive losing-trade streak (breakeven is neutral). */
    consecutiveLosses: integer('consecutive_losses').notNull().default(0),
    /** Exchange/exit time (ms) the most recent losing trade closed at. */
    lastLossClosedAtMs: bigint('last_loss_closed_at_ms', { mode: 'number' }),
    /** Intraday high-water equity for the personal daily-drawdown reference. */
    dayHighEquityMicros: micros('day_high_equity_micros'),
    /** Running realized net trading P&L for the day (fees included). */
    realizedNetPnlMicros: micros('realized_net_pnl_micros').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('trader_risk_day_state_account_date_key').on(t.accountId, t.tradeDate),
  ],
);
