/** Shapes returned by the Atlas REST API, mirroring the server presenters. */

export interface ApiUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export interface AuthResponse {
  user: ApiUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ApiRuleTemplate {
  id: string;
  name: string;
  accountType: string;
  accountSizeMicros: number;
  profitTargetMicros: number;
  maxLossMicros: number;
  drawdownType: 'STATIC' | 'INTRADAY_TRAILING' | 'EOD_TRAILING';
  trailingLockAtMicros: number | null;
  dailyLossLimitMicros: number | null;
  consistencyFormula: string;
  consistencyThreshold: number | null;
  maxContracts: number;
  microsCountAsFraction: boolean;
  minTradingDays: number;
  maxTradingDays: number | null;
  payoutRules: Record<string, number>;
}

export interface ApiAccount {
  id: string;
  name: string;
  accountType: string;
  status: string;
  ruleTemplate: ApiRuleTemplate;
  startingBalanceMicros: number;
  balanceMicros: number;
  realizedPnlMicros: number;
  feesMicros: number;
  highWaterMarkMicros: number;
  drawdownFloorMicros: number;
  equityMicros: number;
  openPnlMicros: number;
  dayPnlMicros: number;
  remainingDrawdownMicros: number;
  remainingDailyLossMicros: number | null;
  profitTargetProgressMicros: number;
  tradingDaysCount: number;
  currentTradeDate: string | null;
  failedReason: string | null;
  seq: number;
  createdAt: number;
}

export interface ApiInstrument {
  root: string;
  displayName: string;
  description: string;
  exchange: string;
  assetClass: string;
  currency: string;
  pricePrecision: number;
  tickSize: number;
  tickSizeScaled: number;
  ticksPerPoint: number;
  tickValueMicros: number;
  pointValueMicros: number;
  contractMultiplier: number;
  sessionTimezone: string;
  sessionLabel: string;
  regularHours: { startMinute: number; endMinute: number };
  supportedOrderTypes: string[];
  commissionPerSideMicros: number;
  exchangeFeesPerSideMicros: number;
  minOrderQty: number;
  maxOrderQty: number;
  isMicro: boolean;
  fullSizeRoot: string | null;
  activeContract: {
    code: string;
    display: string;
    month: number;
    year: number;
    lastTradingDay: number;
    rollDate: number;
  };
  marketState: {
    state: 'OPEN' | 'CLOSED' | 'MAINTENANCE' | 'PRE_OPEN';
    reason: string | null;
    exchangeLocal: string;
    tradingDate: string;
  };
}
