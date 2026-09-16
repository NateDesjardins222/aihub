/** Trading REST client. Every figure returned here was computed by the server. */
import { api } from '../api/client';

export interface ApiOrder {
  id: string;
  accountId: string;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  filledQty: number;
  remainingQty: number;
  type: string;
  limitTicks: number | null;
  stopTicks: number | null;
  limitPrice: number | null;
  stopPrice: number | null;
  tif: string;
  status: string;
  stopTriggered: boolean;
  avgFillPrice: number | null;
  ocoGroupId: string | null;
  bracketRole: string;
  trailTicks: number | null;
  rejectReason: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ApiPosition {
  symbol: string;
  side: 'LONG' | 'SHORT' | 'FLAT';
  qty: number;
  signedQty: number;
  avgEntryPrice: number | null;
  markPrice: number | null;
  unrealizedPnlMicros: number;
  realizedPnlMicros: number;
  feesMicros: number;
  openedAt: number | null;
  stopOrderId: string | null;
  targetOrderId: string | null;
}

export interface ApiTrade {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  grossPnlMicros: number;
  feesMicros: number;
  netPnlMicros: number;
  tradeDate: string;
}

export interface ApiExecution {
  id: string;
  orderId: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  feesMicros: number;
  slippageTicks: number;
  liquidity: string;
  execTime: number;
}

export interface ApiAccountPnl {
  accountId: string;
  status: string;
  startingBalanceMicros: number;
  balanceMicros: number;
  equityMicros: number;
  openPnlMicros: number;
  realizedPnlMicros: number;
  feesMicros: number;
  dayPnlMicros: number;
  drawdownFloorMicros: number;
  remainingDrawdownMicros: number;
  profitTargetProgressMicros: number;
  profitTargetMicros: number;
  openContracts: number;
  maxContracts: number;
  seq: number;
}

export interface SimulationEnvironment {
  fillModel: 'SIMPLE' | 'ADVANCED' | 'DEPTH_AWARE';
  useBarRange: boolean;
  intrabarPolicy: 'ADVERSE_FIRST' | 'OBSERVED_ONLY';
  latencyMs: number;
  marketSlippageTicks: number;
  stopSlippageTicks: number;
  maxContractsPerFill: number | null;
  requireThroughTradeForLimit: boolean;
  feesEnabled: boolean;
  commissionPerSideMicrosOverride: number | null;
}

export type BracketUnit = 'TICKS' | 'POINTS' | 'DOLLARS';

export interface SubmitOrderBody {
  accountId: string;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT' | 'TRAILING_STOP';
  limitPrice?: number | null;
  stopPrice?: number | null;
  tif?: 'DAY' | 'GTC' | 'IOC' | 'FOK';
  trailTicks?: number | null;
  bracket?: {
    stopLoss?: { unit: BracketUnit; value: number } | null;
    takeProfit?: { unit: BracketUnit; value: number } | null;
    trailingStop?: { unit: BracketUnit; value: number } | null;
  } | null;
}

export const tradingApi = {
  submit: (body: SubmitOrderBody) => api.post<unknown>('/api/v1/orders', body),
  modify: (accountId: string, orderId: string, patch: Record<string, unknown>) =>
    api.patch<unknown>(`/api/v1/orders/${orderId}?accountId=${accountId}`, patch),
  cancel: (accountId: string, orderId: string) =>
    api.delete<unknown>(`/api/v1/orders/${orderId}?accountId=${accountId}`),
  cancelAll: (accountId: string, symbol?: string) =>
    api.post<unknown>('/api/v1/orders/cancel-all', { accountId, symbol }),
  orders: (accountId: string) =>
    api.get<{ orders: ApiOrder[] }>(`/api/v1/orders?accountId=${accountId}`),
  positions: (accountId: string) =>
    api.get<{ positions: ApiPosition[] }>(`/api/v1/positions?accountId=${accountId}`),
  trades: (accountId: string) =>
    api.get<{ trades: ApiTrade[] }>(`/api/v1/trades?accountId=${accountId}`),
  executions: (accountId: string) =>
    api.get<{ executions: ApiExecution[] }>(`/api/v1/executions?accountId=${accountId}`),
  pnl: (accountId: string) => api.get<ApiAccountPnl>(`/api/v1/accounts/${accountId}/pnl`),
  flatten: (accountId: string, symbol: string) =>
    api.post<unknown>(`/api/v1/positions/${symbol}/flatten`, { accountId }),
  reverse: (accountId: string, symbol: string) =>
    api.post<unknown>(`/api/v1/positions/${symbol}/reverse`, { accountId }),
  environment: (accountId: string) =>
    api.get<{ environment: SimulationEnvironment; depthAwareAvailable: boolean }>(
      `/api/v1/accounts/${accountId}/environment`,
    ),
  setEnvironment: (accountId: string, patch: Partial<SimulationEnvironment>) =>
    api.put<{ environment: SimulationEnvironment }>(
      `/api/v1/accounts/${accountId}/environment`,
      patch,
    ),
};

/** Idempotency key for a submission. Retrying with the same key cannot double-fill. */
export function newClientOrderId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${performance.now()}`;
  return `${prefix}-${random}`;
}
