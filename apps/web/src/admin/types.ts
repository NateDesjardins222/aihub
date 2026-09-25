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
  /** Read-only view of the trader's personal risk controls (Milestone 5). */
  personalRisk?: {
    tradingDay: string | null;
    controls: Array<{
      controlType: string;
      kind: string;
      mode: 'FLEXIBLE' | 'LOCKED';
      locked: boolean;
      lockedTradingDay: string | null;
      valueMicros: number | null;
      valueInt: number | null;
      windowStart: string | null;
      windowEnd: string | null;
      sessions: string[] | null;
      usage: Record<string, unknown> | null;
    }>;
  } | null;
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

export interface AdminProviderHealth {
  providerId: string;
  role: 'MARKET_DATA' | 'EXECUTION';
  kind: string;
  configState: 'UNCONFIGURED' | 'CONFIGURED';
  health: 'UNCONFIGURED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'ERROR';
  isSimulation: boolean;
  detail: string;
  lastConnectAt: number | null;
  lastDisconnectAt: number | null;
  lastMessageAt: number | null;
  lastHeartbeatAt: number | null;
  reconnectCount: number;
  subscriptionCount: number;
  lastError: string | null;
}

/** Production-infrastructure posture + provider health (M4-Z). Read-only. */
export interface AdminInfra {
  generatedAt: number;
  posture: {
    configuredExecutionProvider: 'simulation' | 'rithmic' | 'scripted';
    defaultExecutionMode: 'SIMULATION';
    externalLiveEnabled: boolean;
    marketDataProvider: string;
    marketDataRedistribution: string;
    rithmic: {
      configState: 'UNCONFIGURED' | 'CONFIGURED';
      description: string;
      enabled: boolean;
      environment: string;
      systemName: string | null;
      endpointHost: string | null;
      marketDataEnabled: boolean;
      executionEnabled: boolean;
      metrics: Record<string, number | null>;
    };
  };
  providers: AdminProviderHealth[];
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

// -- Economics simulator ----------------------------------------------------

export interface EconProductResult {
  key: string;
  model: string;
  sizeMicros: number;
  purchases: number;
  grossRevenueMicros: number;
  fundedAccounts: number;
  payoutRecipients: number;
  payoutEvents: number;
  grossTraderPayoutsMicros: number;
  firmRetainedSplitMicros: number;
}
export interface EconResult {
  purchases: number;
  grossRevenueMicros: number;
  avgRevenuePerPurchaseMicros: number;
  passes: number;
  passRate: number;
  fundedAccounts: number;
  payoutRecipients: number;
  purchaseToPayoutPct: number;
  payoutEvents: number;
  grossTraderPayoutsMicros: number;
  firmRetainedSplitMicros: number;
  payoutToRevenuePct: number;
  processingCostMicros: number;
  fraudCostMicros: number;
  platformCostMicros: number;
  supportCostMicros: number;
  cacMicros: number;
  fixedCostsMicros: number;
  contributionMicros: number;
  contributionMargin: number;
  byProduct: EconProductResult[];
}
export interface EconDistribution { mean: number; median: number; p5: number; p25: number; p75: number; p95: number; }
export interface EconSensitivityPoint { factor: number; contributionMicros: number; contributionMargin: number; }
export interface EconomicsRun {
  id: string;
  scenario: string;
  assumptions: unknown;
  result: EconResult;
  sensitivity: { payoutExpense: EconSensitivityPoint[]; passRate: EconSensitivityPoint[]; cac: EconSensitivityPoint[] };
  monteCarlo: {
    trials: number;
    purchasesPerTrial: number;
    revenue: EconDistribution;
    payoutExpense: EconDistribution;
    contribution: EconDistribution;
    contributionMarginBps: EconDistribution;
    fundedAccounts: EconDistribution;
    payoutRecipients: EconDistribution;
  };
  caps: { conservative: EconResult; current: EconResult; generous: EconResult };
  reserve: { reserveMicros: number; tailMicros: number; basisMicros: number };
}

// -- Economics engine M13.0 (v2): full lifecycle + time/cash-flow ------------

export interface EconV2Product {
  key: string; family: string; size: string;
  customers: number; purchases: number; resets: number; passes: number; fundedAccounts: number; payoutEvents: number;
  resetRevenueMicros: number; grossSalesMicros: number; netRevenueMicros: number; traderPayoutMicros: number; affiliateExpenseMicros: number;
  processingCostMicros: number; refundLossMicros: number; chargebackLossMicros: number;
  operatingAllocationMicros: number; acquisitionCostMicros: number; contributionMicros: number;
}
export interface EconV2CashPeriod {
  monthIndex: number; cashInMicros: number; traderPayoutCashMicros: number; affiliateCashMicros: number;
  refundCashMicros: number; chargebackCashMicros: number; operatingCashMicros: number; acquisitionCashMicros: number;
  netCashMicros: number; cumulativeCashMicros: number; reserveRequirementMicros: number; distributableCashMicros: number;
}
export interface EconV2Result {
  customers: number; horizonDays: number; months: number;
  purchases: number; resets: number; repurchases: number; passes: number; passRate: number;
  fundedAccounts: number; payoutRecipients: number; purchaseToPayoutPct: number;
  initialRevenueMicros: number; resetRevenueMicros: number; repurchaseRevenueMicros: number;
  grossSalesMicros: number; refundLossMicros: number; chargebackLossMicros: number; netRevenueMicros: number;
  refunds: number; chargebacks: number;
  payouts: {
    eligibleAccounts: number; requestedEvents: number; approvedEvents: number; paidEvents: number;
    grossPayoutMicros: number; traderShareMicros: number; firmShareMicros: number;
    paidTraderShareMicros: number; approvedUnpaidTraderShareMicros: number;
  };
  affiliate: {
    attributedCustomers: number; commissionsCreated: number; grossCommissionMicros: number; maturedCommissionMicros: number;
    paidCommissionMicros: number; unpaidLiabilityMicros: number; reversedCommissionMicros: number; canceledCommissionMicros: number;
    netCommissionExpenseMicros: number; costPctOfAttributableRevenue: number;
  };
  processingCostMicros: number; chargebackFeeMicros: number; operatingCostMicros: number; acquisitionCostMicros: number;
  contributionMicros: number; contributionMargin: number;
  treasury: {
    cashCollectedMicros: number; payoutLiabilityMicros: number; affiliateLiabilityMicros: number;
    refundReserveMicros: number; operatingReserveMicros: number; taxPlaceholderMicros: number; safetyReserveMicros: number;
    requiredReserveMicros: number; distributableCashMicros: number;
  };
  timeline: EconV2CashPeriod[];
  byProduct: EconV2Product[];
}
export interface EconV2Dist { worseTail: 'LOW' | 'HIGH'; mean: number; p10: number; p25: number; median: number; p75: number; p90: number; }
export interface EconV2SensPoint { value: number; contributionMicros: number; contributionMargin: number; netRevenueMicros: number; traderPayoutMicros: number; }
export interface EconV2BreakEven { lever: string; breakEvenValue: number | null; decreasingInLever: boolean; baselineContributionMicros: number; }
export interface EconV2MonteCarlo {
  trials: number;
  revenue: EconV2Dist; payoutExpense: EconV2Dist; contribution: EconV2Dist; reserveRequirement: EconV2Dist; distributableCash: EconV2Dist; fundedAccounts: EconV2Dist;
  probContributionNegative: number; probLiquidityStress: number; suggestedSafetyReserveMicros: number;
}
export interface EconV2Bundle {
  engineVersion: string; modelVersion: string; generatedAt: string;
  scenario: string; seed: number; customers: number; horizonDays: number; trials: number;
  assumptions: Record<string, unknown>;
  result: EconV2Result;
  sensitivity: Record<string, EconV2SensPoint[]>;
  monteCarlo: EconV2MonteCarlo;
  breakEven: EconV2BreakEven[];
}
export interface EconV2RunResponse { id: string | null; bundle: EconV2Bundle; }
export interface EconV2ConfigResponse { scenarios: string[]; base: Record<string, unknown>; authoritative: Record<string, number>; products: unknown[]; }

// ---- enforcement (M7) -------------------------------------------------------
// A case is a review, never a verdict; severity is triage urgency, not guilt.
export interface EnfCase {
  id: string;
  organizationId: string;
  customerIdentityId: string;
  subjectAccountId: string | null;
  category: string;
  severity: string;
  status: string;
  customerSafeCategory: string;
  reasonCode: string | null;
  assignedToUserId: string | null;
  correlationKey: string | null;
  publicRef: string;
  openedAt: string;
  updatedAt: string;
  closedAt: string | null;
  version: number;
}

export interface EnfSignal {
  id: string;
  caseId: string | null;
  customerIdentityId: string | null;
  accountId: string | null;
  source: string;
  kind: string;
  severity: string;
  sourceRef: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  capturedAt: string;
  dedupeKey: string;
}

export interface EnfHold {
  id: string;
  caseId: string | null;
  scope: string;
  scopeId: string;
  capability: string;
  reasonCode: string;
  customerSafeCategory: string | null;
  status: string;
  createdBySystem: boolean;
  createdAt: string;
  expiresAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  version: number;
}

export interface EnfFinding {
  id: string;
  caseId: string;
  reasonCode: string;
  adverse: boolean;
  appealable: boolean;
  summarySafe: string | null;
  rationaleInternal: string | null;
  status: string;
  supersededByFindingId: string | null;
  decidedAt: string;
}

export interface EnfAction {
  id: string;
  caseId: string;
  actionType: string;
  reasonCode: string | null;
  holdId: string | null;
  performedBySystem: boolean;
  performedAt: string;
}

export interface EnfNote {
  id: string;
  caseId: string;
  authorUserId: string | null;
  body: string;
  visibility: string;
  createdAt: string;
}

export interface EnfEvidence {
  id: string;
  caseId: string;
  type: string;
  source: string;
  sourceRef: string | null;
  visibility: string;
  integrityHash: string | null;
  capturedAt: string;
}

export interface EnfInfoRequest {
  id: string;
  caseId: string;
  requestType: string;
  messageSafe: string;
  requestedAt: string;
  dueAt: string | null;
  responseStatus: string;
  responseText: string | null;
  respondedAt: string | null;
}

export interface EnfAppeal {
  id: string;
  caseId: string;
  originalFindingId: string | null;
  originalDeciderUserId: string | null;
  customerStatement: string | null;
  status: string;
  reviewerUserId: string | null;
  customerSafeExplanation: string | null;
  submittedAt: string;
  decisionAt: string | null;
  version: number;
}

export interface EnfAppealDecision {
  id: string;
  appealId: string;
  caseId: string;
  decision: string;
  rationaleInternal: string | null;
  customerSafeExplanation: string | null;
  overrideSameReviewer: boolean;
  decidedAt: string;
}

export interface EnfCaseDetail {
  case: EnfCase;
  signals: EnfSignal[];
  evidence: EnfEvidence[];
  findings: EnfFinding[];
  actions: EnfAction[];
  holds: EnfHold[];
  notes: EnfNote[];
  informationRequests: EnfInfoRequest[];
  appeals: EnfAppeal[];
  appealDecisions: EnfAppealDecision[];
}

export interface EnfSummary { openCases: number; holds: number; appeals: number }
