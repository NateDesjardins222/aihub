/**
 * TradingView Advanced Charts adapter — LICENSED / EXTERNAL, NOT IMPLEMENTED.
 *
 * Advanced Charts (the Charting Library) is a commercial TradingView product.
 * Using it requires a signed licence agreement and a library bundle distributed
 * by TradingView, neither of which this project possesses.
 *
 * This file exists so the integration point is real and the rest of the platform
 * stays engine-agnostic. It contains NO TradingView source code. What it does
 * contain is the shape of the two objects their documented integration expects a
 * host application to supply — a datafeed and a broker — expressed in our own
 * types, so that a licensee can drop in the bundle and wire it up without
 * touching any trading code.
 *
 * Constructing it without a bundle throws, deliberately and loudly. Nothing here
 * should ever be mistaken for working functionality.
 */
import type { NormalizedBar, Timeframe } from '@atlas/contracts';
import type {
  ChartAdapter,
  ChartInit,
  ChartType,
  CrosshairInfo,
  OrderLineHandle,
  OrderLineSpec,
  PriceScaleMode,
  VisibleRange,
} from './ChartAdapter';

export class AdvancedChartsUnavailableError extends Error {
  constructor() {
    super(
      'TradingView Advanced Charts is a licensed product. This build does not ' +
        'include the library bundle, and no part of it is implemented here. ' +
        'Obtain a licence from TradingView, place the bundle on the host, and ' +
        'set VITE_TRADINGVIEW_LIBRARY_PATH to enable this adapter.',
    );
    this.name = 'AdvancedChartsUnavailableError';
  }
}

/** Is a licensed bundle configured? Checked before ever offering this engine. */
export function advancedChartsAvailable(): boolean {
  const path = import.meta.env?.['VITE_TRADINGVIEW_LIBRARY_PATH'];
  return typeof path === 'string' && path.length > 0;
}

/**
 * The bar-request shape a datafeed implementation would satisfy. Our
 * MarketDataProvider already answers exactly this, which is the point: the
 * adapter would be a thin translation, not a second data path.
 */
export interface DatafeedBarsRequest {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly from: number;
  readonly to: number;
  readonly firstRequest: boolean;
}

export interface DatafeedBridge {
  resolveSymbol(symbol: string): Promise<{
    ticker: string;
    name: string;
    description: string;
    pricescale: number;
    minmov: number;
    session: string;
    timezone: string;
    has_intraday: boolean;
    supported_resolutions: readonly string[];
  }>;
  getBars(request: DatafeedBarsRequest): Promise<readonly NormalizedBar[]>;
  subscribeBars(
    symbol: string,
    timeframe: Timeframe,
    onTick: (bar: NormalizedBar) => void,
  ): () => void;
}

/**
 * The broker shape the licensed library's trading integration expects. Our
 * server-side simulation engine is the authority behind every one of these;
 * the adapter would forward, never decide.
 */
export interface BrokerBridge {
  placeOrder(request: unknown): Promise<{ orderId: string }>;
  modifyOrder(orderId: string, patch: unknown): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  positions(): Promise<readonly unknown[]>;
  orders(): Promise<readonly unknown[]>;
}

export class TradingViewAdvancedChartsAdapter implements ChartAdapter {
  readonly engineId = 'tradingview-advanced-charts';
  readonly engineName = 'TradingView Advanced Charts (licensed - not included)';

  constructor(_bridges?: { datafeed: DatafeedBridge; broker?: BrokerBridge }) {
    throw new AdvancedChartsUnavailableError();
  }

  mount(_init: ChartInit): void {
    throw new AdvancedChartsUnavailableError();
  }
  destroy(): void {}
  resize(): void {}
  setChartType(_type: ChartType): void {}
  getChartType(): ChartType {
    return 'CANDLES';
  }
  setPriceScaleMode(_mode: PriceScaleMode): void {}
  setTimeframe(_tf: Timeframe): void {}
  applyHistory(_bars: readonly NormalizedBar[]): void {}
  prependHistory(_bars: readonly NormalizedBar[]): void {}
  applyLiveBar(_bar: NormalizedBar): void {}
  setVolumeVisible(_visible: boolean): void {}
  setSessionBreaksVisible(_visible: boolean): void {}
  fitContent(): void {}
  scrollToRealtime(): void {}
  resetScale(): void {}
  setAutoScale(_enabled: boolean): void {}
  goToTime(_time: number): void {}
  getVisibleRange(): VisibleRange | null {
    return null;
  }
  onNeedMoreHistory(_cb: (oldest: number) => void): () => void {
    return () => {};
  }
  onCrosshairMove(_cb: (info: CrosshairInfo) => void): () => void {
    return () => {};
  }
  onVisibleRangeChange(_cb: (range: VisibleRange | null) => void): () => void {
    return () => {};
  }
  addOrderLine(_spec: OrderLineSpec): OrderLineHandle {
    throw new AdvancedChartsUnavailableError();
  }
  clearOrderLines(): void {}
  async screenshot(): Promise<Blob | null> {
    return null;
  }
  priceToY(_price: number): number | null {
    return null;
  }
  yToPrice(_y: number): number | null {
    return null;
  }
}
