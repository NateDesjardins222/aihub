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
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** bigint columns come back as strings from postgres.js; this keeps them numeric. */
const micros = (name: string) => bigint(name, { mode: 'number' });

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
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
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
  payoutRules: jsonb('payout_rules').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: now(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ruleTemplateId: uuid('rule_template_id')
      .notNull()
      .references(() => ruleTemplates.id),
    name: varchar('name', { length: 80 }).notNull(),
    accountType: varchar('account_type', { length: 20 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('ACTIVE'),
    startingBalanceMicros: micros('starting_balance_micros').notNull(),
    balanceMicros: micros('balance_micros').notNull(),
    realizedPnlMicros: micros('realized_pnl_micros').notNull().default(0),
    feesMicros: micros('fees_micros').notNull().default(0),
    highWaterMarkMicros: micros('high_water_mark_micros').notNull(),
    drawdownFloorMicros: micros('drawdown_floor_micros').notNull(),
    tradingDaysCount: integer('trading_days_count').notNull().default(0),
    currentTradeDate: date('current_trade_date'),
    dayStartBalanceMicros: micros('day_start_balance_micros').notNull(),
    dayStartEquityMicros: micros('day_start_equity_micros').notNull(),
    /** Monotonic event sequence used for WebSocket snapshot/delta recovery. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    failedReason: text('failed_reason'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
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
    side: varchar('side', { length: 4 }).notNull(),
    qty: integer('qty').notNull(),
    filledQty: integer('filled_qty').notNull().default(0),
    type: varchar('type', { length: 16 }).notNull(),
    limitTicks: integer('limit_ticks'),
    stopTicks: integer('stop_ticks'),
    tif: varchar('tif', { length: 4 }).notNull().default('DAY'),
    status: varchar('status', { length: 20 }).notNull(),
    avgFillTicks: real('avg_fill_ticks'),
    ocoGroupId: uuid('oco_group_id'),
    parentOrderId: uuid('parent_order_id'),
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
    qty: integer('qty').notNull().default(0),
    avgEntryTicks: real('avg_entry_ticks').notNull().default(0),
    realizedPnlMicros: micros('realized_pnl_micros').notNull().default(0),
    feesMicros: micros('fees_micros').notNull().default(0),
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
    side: varchar('side', { length: 6 }).notNull(),
    qty: integer('qty').notNull(),
    entryTicks: real('entry_ticks').notNull(),
    exitTicks: real('exit_ticks').notNull(),
    entryTime: timestamp('entry_time', { withTimezone: true }).notNull(),
    exitTime: timestamp('exit_time', { withTimezone: true }).notNull(),
    grossPnlMicros: micros('gross_pnl_micros').notNull(),
    feesMicros: micros('fees_micros').notNull(),
    netPnlMicros: micros('net_pnl_micros').notNull(),
    tradeDate: date('trade_date').notNull(),
    createdAt: now(),
  },
  (t) => [
    index('trades_account_idx').on(t.accountId, t.exitTime),
    index('trades_date_idx').on(t.accountId, t.tradeDate),
  ],
);

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
