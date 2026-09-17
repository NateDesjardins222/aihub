/** What the admin API returns. Mirrors apps/server/src/http/routes/admin.ts. */

export interface AdminOverview {
  users: { total: number; active: number };
  accounts: {
    total: number;
    byStatus: Record<string, number>;
    active: number;
    passed: number;
    failed: number;
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
