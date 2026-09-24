/** What the admin API returns. Mirrors apps/server/src/http/routes/admin.ts. */

export interface AdminOverview {
  users: { total: number; active: number };
  accounts: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    active: number;
    passed: number;
    failed: number;
  };
  lifecycle: {
    activeEvaluations: number;
    fundedSim: number;
    passedEvaluations: number;
    awaitingFunding: number;
    passedToday: number;
    failedToday: number;
  };
  exposure: { openPositions: number; openContracts: number; workingOrders: number };
  volume: { fills24h: number; contracts24h: number };
  money: {
    balanceMicros: number;
    startingBalanceMicros: number;
    realizedPnlMicros: number;
    feesMicros: number;
    netPnlMicros: number;
    closedTrades: number;
  };
  activity: AuditEntry[];
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: { type: string; userId: string | null; label: string | null };
  subjectType: string;
  subjectId: string | null;
  accountId: string | null;
  userId: string | null;
  prevState: unknown;
  newState: unknown;
  reason: string | null;
  at: number;
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  createdAt: number;
  lastLoginAt: number | null;
  accountCount?: number;
  evaluationAccounts?: number;
  fundedSimAccounts?: number;
  activeAccounts?: number;
  lastTradedAt?: number | null;
}

export interface AdminAccount {
  id: string;
  publicId: string;
  name: string;
  accountType: string;
  status: string;
  product: { key: string; name: string; version: number } | null;
  startingBalanceMicros: number;
  balanceMicros: number;
  realizedPnlMicros: number;
  feesMicros: number;
  highWaterMarkMicros: number;
  drawdownFloorMicros: number;
  tradingDaysCount: number;
  failedReason: string | null;
  externalMetadata: unknown;
  instrumentLimits: unknown;
  activatedAt: number | null;
  createdAt: number;
  owner?: { id: string; email: string; displayName: string };
  openContracts?: number;
  lastTradedAt?: number | null;
}

export interface AdminLifecycle {
  id: string;
  seq: number;
  startingBalanceMicros: number;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  finalBalanceMicros: number | null;
  finalStatus: string | null;
}

export interface AdminAccountDetail {
  account: AdminAccount;
  owner: { id: string; email: string; displayName: string };
  rules: Record<string, unknown> | null;
  lifecycles: AdminLifecycle[];
  orders: AdminOrder[];
  fills: AdminFill[];
  positions: AdminPosition[];
  violations: Array<{ id: string; rule: string; reasonCode: string; detail: unknown; at: number }>;
  trades: Array<{
    id: string;
    symbol: string;
    side: string;
    qty: number;
    netPnlMicros: number;
    entryTime: number;
    exitTime: number;
    tradeDate: string;
  }>;
  audit: AuditEntry[];
  lockReason?: { canTrade: boolean; reason: string; detail: string | null };
  commercial?: {
    qualification: {
      id: string;
      fundingState: 'ELIGIBLE' | 'FUNDED' | 'DECLINED';
      qualifiedAt: number;
      fundedAccountId: string | null;
      declineReason: string | null;
    } | null;
    fundedFrom: { accountId: string; publicId: string; qualificationId: string } | null;
  };
}

export interface AdminOrder {
  id: string;
  symbol: string;
  side: string;
  type: string;
  qty: number;
  filledQty: number;
  status: string;
  limitPrice: number | null;
  stopPrice: number | null;
  rejectReason: string | null;
  createdAt: number;
}

export interface AdminFill {
  id: string;
  orderId?: string;
  symbol: string;
  side: string;
  qty: number;
  price: number | null;
  feesMicros?: number;
  realizedPnlMicros: number;
  execTime: number;
}

export interface AdminPosition {
  symbol: string;
  side: string;
  qty: number;
  costBasisMicros: number;
  realizedPnlMicros: number;
  openedAt: number | null;
}

export interface AdminLiveView {
  accountId: string;
  publicId: string;
  status: string;
  valuation: {
    accountId: string;
    balanceMicros: number;
    equityMicros: number;
    openPnlMicros: number;
    realizedPnlMicros: number;
    feesMicros: number;
    dayPnlMicros: number;
    remainingDrawdownMicros: number;
    openContracts: number;
    positions: Array<Record<string, unknown>>;
    rules: Record<string, unknown>;
    at: number;
  } | null;
  workingOrders: AdminOrder[];
  recentFills: AdminFill[];
  recentViolations: Array<{ rule: string; reasonCode: string; at: number }>;
}

export interface AdminProfile {
  id: string;
  key: string;
  name: string;
  accountType: string;
  status: string;
  description: string | null;
  latestVersion: { id: string; version: number; config: unknown } | null;
}

/** The rule half of a product config, as the engine consumes it. */
export interface ProductRules {
  accountSizeMicros: number;
  profitTargetMicros: number;
  maxLossMicros: number;
  drawdownType: 'STATIC' | 'INTRADAY_TRAILING' | 'EOD_TRAILING';
  trailingLockAtMicros: number | null;
  dailyLossLimitMicros: number | null;
  dailyLossPolicy: 'LOCK_DAY' | 'FAIL';
  consistencyFormula: 'BEST_DAY_OVER_TOTAL' | 'BEST_DAY_OVER_TARGET';
  consistencyThreshold: number | null;
  minTradingDays: number;
  minWinningDays: number;
  maxTradingDays: number | null;
  minDailyPnlToCountMicros: number;
  minWinningDayPnlMicros: number;
  maxContracts: number;
  microsCountAsFraction: boolean;
  flattenOnBreach: boolean;
}

export interface ProductConfig {
  rules: ProductRules;
  execution: Record<string, unknown> | null;
  instruments: {
    allowed: string[] | null;
    maxContracts: number | null;
    perInstrument: Record<string, number>;
  };
  display: { startingBalanceMicros?: number };
  payoutRules: unknown;
}

export interface AdminProductVersion {
  id: string;
  version: number;
  config: ProductConfig;
  notes: string | null;
  createdByUserId: string | null;
  publishedAt: number;
}

export interface AdminProductDraft {
  id: string;
  profileId: string | null;
  key: string;
  name: string;
  accountType: string;
  description: string | null;
  config: ProductConfig;
  notes: string | null;
  baseVersion: number | null;
  updatedByUserId: string | null;
  updatedAt: number;
}

export interface AdminProductDetail {
  profile: {
    id: string;
    key: string;
    name: string;
    accountType: string;
    status: string;
    description: string | null;
    createdAt: number;
    updatedAt: number;
  } | null;
  versions: AdminProductVersion[];
  draft: AdminProductDraft | null;
}

export interface AdminTradingPosition {
  accountId: string;
  accountPublicId: string | null;
  trader: string | null;
  symbol: string;
  side: string;
  qty: number;
  avgEntryPrice: number | null;
  markPrice: number | null;
  unrealizedPnlMicros: number | null;
  openedAt: number | null;
}

export interface AdminTrading {
  openPositions: AdminTradingPosition[];
  openContracts: number;
  workingOrders: Array<AdminOrder & { accountId: string; accountPublicId: string; trader: string }>;
  recentFills: Array<
    AdminFill & { accountId: string; accountPublicId: string; trader: string; feesMicros: number | null }
  >;
}

export interface AdminRiskAccount {
  accountId: string;
  accountPublicId: string | null;
  trader: string | null;
  openPnlMicros: number | null;
  remainingDrawdownMicros: number | null;
  openContracts: number;
  equityMicros: number | null;
}

export interface AdminRiskBrief {
  accountId: string;
  accountPublicId: string;
  name: string;
  trader: string;
  balanceMicros: number;
  failedReason: string | null;
  updatedAt: number | null;
}

export interface AdminRisk {
  nearestLossLimit: AdminRiskAccount[];
  largestUnrealizedLoss: AdminRiskAccount[];
  onHold: AdminRiskBrief[];
  recentFailures: AdminRiskBrief[];
}

export interface AdminSystem {
  api: { state: string };
  database: { state: string };
  marketData: {
    state: 'HEALTHY' | 'DELAYED' | 'DEGRADED' | 'OFFLINE';
    provider: string | null;
    mode: string;
    delaySeconds: number | null;
    connection: string;
    lastQuoteExchangeTs: number | null;
    ageMs: number | null;
    blocksOrderEntry: boolean;
  };
  audit: { state: string };
  projections?: { state: string; total: number; inconsistent: number; lastUpdatedAt: number | null };
  outbox?: { state: string; pending: number; deadLetter: number; oldestPendingAgeMs: number | null };
  payments?: { provider: string; state: string; environment: string | null };
  build: { nodeEnv: string; version: string | null; at: number };
}

export interface FundingQualification {
  id: string;
  fundingState: 'ELIGIBLE' | 'FUNDED' | 'DECLINED';
  balanceMicros: number;
  qualifiedAt: number;
  fundedAccountId: string | null;
  declineReason: string | null;
  approvedAt: number | null;
  account: {
    id: string;
    publicId: string;
    status: string;
    accountType: string;
    startingBalanceMicros: number;
    hasFundedDestination: boolean;
  };
  product: { key: string; name: string } | null;
  trader: { id: string; email: string; displayName: string };
}

export interface FundingQualificationDetail {
  qualification: FundingQualification;
  evidence: {
    requirements: Array<{
      key: string;
      label: string;
      required: number;
      actual: number;
      unit: string;
      met: boolean;
    }>;
    balanceMicros: number;
    startingBalanceMicros: number;
  };
  fundedAccount: { id: string; publicId: string; status: string; accountType: string } | null;
}

export interface TraderNote {
  id: string;
  category: string;
  body: string | null;
  redacted: boolean;
  author: string | null;
  createdAt: number;
  redactedAt: number | null;
}

export interface AdminExposureContributor {
  accountId: string;
  accountPublicId: string;
  accountType: string | null;
  trader: string;
  side: string;
  qty: number;
  markPrice: number | null;
  unrealizedPnlMicros: number | null;
}

export interface AdminExposureSymbol {
  symbol: string;
  pointValueMicros: number | null;
  grossLong: number;
  grossShort: number;
  net: number;
  positions: number;
  unknownMarks: number;
  notionalMicros: number | null;
  unrealizedPnlMicros: number | null;
  contributors: AdminExposureContributor[];
}

export interface AdminExposure {
  symbols: AdminExposureSymbol[];
  scannedAccounts: number;
  generatedAt: number;
}

// -- Payout engine ----------------------------------------------------------

export interface PayoutListRow {
  id: string;
  state: string;
  accountId: string;
  accountPublicId: string | null;
  accountName: string;
  accountStatus: string;
  adminHold: string | null;
  productName: string | null;
  accountType: string;
  traderEmail: string | null;
  requestedGrossMicros: number;
  traderShareMicros: number | null;
  firmShareMicros: number | null;
  balanceMicros: number;
  protectedBufferMicros: number | null;
  withdrawableBeforeMicros: number | null;
  payoutOrdinal: number;
  holdKind: string | null;
  createdAt: string;
}

export interface PayoutEligibilityView {
  state: 'ELIGIBLE' | 'NOT_ELIGIBLE';
  reasonCodes: string[];
  grossWithdrawableMicros: number;
  qualifyingWinningDays: number;
  bestDayMicros: number;
  consistencyRatio: number | null;
  bufferEstablished: boolean;
  dailyModeUnlocked: boolean;
  minRequestMicros: number;
  maxRequestMicros: number;
}

export interface PayoutCase {
  request: {
    id: string;
    state: string;
    requestedGrossMicros: number;
    grossEligibleMicros: number | null;
    traderShareMicros: number | null;
    firmShareMicros: number | null;
    balanceAdjustmentMicros: number | null;
    protectedBufferMicros: number | null;
    withdrawableBeforeMicros: number | null;
    payoutOrdinal: number;
    holdKind: string | null;
    reason: string | null;
    eligibilitySnapshot: unknown;
    createdAt: string;
    decidedAt: string | null;
    paidAt: string | null;
  };
  account: {
    id: string;
    publicId: string | null;
    name: string;
    accountType: string;
    status: string;
    adminHold: string | null;
    balanceMicros: number;
    startingBalanceMicros: number;
  };
  policy: {
    model: string;
    profitSplitPercent: number;
    fundedBufferMicros: number;
    requiredWinningDays: number;
    payoutConsistencyThreshold: number | null;
  };
  liveEligibility: PayoutEligibilityView;
  ledger: Array<{
    entryType: string;
    amountMicros: number;
    balanceBeforeMicros: number;
    balanceAfterMicros: number;
    traderShareMicros: number | null;
    firmShareMicros: number | null;
    createdAt: string;
  }>;
  audit: Array<{ action: string; reason: string | null; newState: unknown; createdAt: string }>;
}

export interface PayoutExposure {
  realizedPaid: { today: number; last7d: number; last30d: number; allTime: number };
  requestedLiabilityMicros: number;
  approvedUnpaidMicros: number;
  eligibleWithdrawableMicros: number;
  byModel: Record<string, { requestedLiabilityMicros: number; paidAllTimeMicros: number }>;
}
