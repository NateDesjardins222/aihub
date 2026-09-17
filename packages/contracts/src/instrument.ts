/**
 * Centralized instrument specification types.
 *
 * Every price in this system is an INTEGER number of ticks relative to an
 * instrument's tick size. Every money amount is an INTEGER number of
 * micro-dollars (1e-6 USD). Floating point is used only at the display edge.
 *
 * Rationale: NQ, ES, GC and CL have different tick sizes and different dollar
 * values per tick. Treating a price as a float and a P&L as a float produces
 * silent rounding drift that is unacceptable in an execution engine.
 */

export type Exchange = 'CME' | 'CBOT' | 'COMEX' | 'NYMEX';

export type AssetClass = 'EQUITY_INDEX' | 'METALS' | 'ENERGY' | 'RATES' | 'FX' | 'AGRICULTURE';

export type OrderTypeName =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP_MARKET'
  | 'STOP_LIMIT'
  | 'TRAILING_STOP';

/** A half-open window inside a trading day, expressed in the exchange's local timezone. */
export interface SessionWindow {
  /** 0 = Sunday … 6 = Saturday, in exchange local time. */
  readonly weekday: number;
  /** Inclusive start, minutes from local midnight. */
  readonly startMinute: number;
  /** Exclusive end, minutes from local midnight. May exceed 1440 to cross midnight. */
  readonly endMinute: number;
}

/** A recurring period during which the market is closed (daily halt / maintenance). */
export interface MaintenanceWindow {
  readonly label: string;
  /** Weekdays (exchange local) this applies to; empty = every trading weekday. */
  readonly weekdays: readonly number[];
  readonly startMinute: number;
  readonly endMinute: number;
}

/** Which calendar months an instrument lists contracts for. */
export type ContractMonthCycle =
  | { readonly kind: 'QUARTERLY' } // Mar, Jun, Sep, Dec
  | { readonly kind: 'MONTHLY' }
  | { readonly kind: 'CUSTOM'; readonly months: readonly number[] }; // 1-12

export interface RollRule {
  readonly cycle: ContractMonthCycle;
  /**
   * How the last trading day of a contract month is derived.
   *  - THIRD_FRIDAY: equity index style (expires 3rd Friday of contract month).
   *  - BUSINESS_DAYS_BEFORE_DAY: energy style (N business days before day D of the
   *    month preceding the contract month).
   *  - BUSINESS_DAYS_BEFORE_MONTH_END: metals style (N business days before the end
   *    of the month preceding the contract month).
   */
  readonly expiry:
    | { readonly kind: 'THIRD_FRIDAY' }
    | { readonly kind: 'BUSINESS_DAYS_BEFORE_DAY'; readonly businessDays: number; readonly dayOfMonth: number }
    | { readonly kind: 'BUSINESS_DAYS_BEFORE_MONTH_END'; readonly businessDays: number };
  /** Roll the front month this many calendar days before last trading day. */
  readonly rollDaysBeforeExpiry: number;
}

export interface InstrumentSpec {
  /** Root symbol, e.g. "NQ". The canonical key used everywhere in the system. */
  readonly root: string;
  readonly displayName: string;
  readonly description: string;
  readonly exchange: Exchange;
  readonly assetClass: AssetClass;
  readonly currency: 'USD';

  /**
   * Price precision (decimal places shown) and the derived integer price scale.
   * scaledPrice = round(price * 10**pricePrecision)
   */
  readonly pricePrecision: number;
  /** Tick size expressed in scaled price units. NQ: 0.25 @ precision 2 => 25. */
  readonly tickSizeScaled: number;

  /** Dollar value of one full point of price movement, for ONE contract. */
  readonly pointValueMicros: number;
  /** Dollar value of one tick, for ONE contract. Must equal pointValue * tickSize. */
  readonly tickValueMicros: number;
  /** Contract multiplier as published by the exchange (index points -> notional). */
  readonly contractMultiplier: number;

  /** IANA timezone the exchange's session calendar is expressed in. */
  readonly sessionTimezone: string;
  /** Human label, e.g. "Sun 18:00 - Fri 17:00 ET". */
  readonly sessionLabel: string;
  readonly sessionWindows: readonly SessionWindow[];
  readonly maintenanceWindows: readonly MaintenanceWindow[];
  /** Regular trading hours used for session-break shading and RTH/ETH filters. */
  readonly regularHours: { readonly startMinute: number; readonly endMinute: number };

  readonly supportedOrderTypes: readonly OrderTypeName[];
  readonly rollRule: RollRule;

  /** Commission charged per contract, per side, in micro-dollars. */
  readonly commissionPerSideMicros: number;
  /** Exchange + clearing + NFA fees per contract per side, micro-dollars. */
  readonly exchangeFeesPerSideMicros: number;

  readonly minOrderQty: number;
  readonly maxOrderQty: number;

  /** Symbol used by the Phase 1 delayed market-data provider. */
  readonly providerSymbols: Readonly<Record<string, string>>;

  /**
   * Whether this instrument can legitimately print at or below zero.
   *
   * WTI crude settled at -$37.63 on 20 April 2020, and Atlas still serves that
   * day, so "a price must be positive" is not a universal rule. The price
   * integrity gate asks the instrument rather than assuming.
   */
  readonly allowsNegativePrice?: boolean;
  /** True if this is a micro-sized contract (used by risk sizing helpers). */
  readonly isMicro: boolean;
  /** Root of the full-size sibling, if this is a micro. */
  readonly fullSizeRoot?: string;
}

export type MarketState =
  | 'OPEN'
  | 'CLOSED'
  | 'MAINTENANCE'
  | 'PRE_OPEN';
