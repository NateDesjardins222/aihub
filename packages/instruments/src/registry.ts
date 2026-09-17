/**
 * THE instrument registry.
 *
 * Nothing else in the platform may hardcode a tick size, a tick value, a point
 * value or a session. The execution engine, the P&L engine, the risk engine,
 * the chart, the DOM and the order panel all resolve these values from here.
 *
 * Specification values below are the published CME Group contract specs for the
 * listed products. They are facts about the contracts, not copied code or assets.
 */
import type { InstrumentSpec, MaintenanceWindow, SessionWindow } from '@atlas/contracts';

const MIN = (h: number, m = 0): number => h * 60 + m;

/**
 * CME Globex electronic session: Sunday 17:00 CT through Friday 16:00 CT, with a
 * 60-minute break each day. Expressed here in US/Central, the exchange's own
 * timezone, so DST is handled by the calendar rather than by an offset constant.
 *
 * Each window opens on the given weekday at 17:00 and runs 23 hours to 16:00 the
 * next day; endMinute > 1440 means the window crosses local midnight.
 */
const GLOBEX_WINDOWS: readonly SessionWindow[] = [
  { weekday: 0, startMinute: MIN(17), endMinute: MIN(16) + 1440 }, // Sun 17:00 -> Mon 16:00
  { weekday: 1, startMinute: MIN(17), endMinute: MIN(16) + 1440 },
  { weekday: 2, startMinute: MIN(17), endMinute: MIN(16) + 1440 },
  { weekday: 3, startMinute: MIN(17), endMinute: MIN(16) + 1440 },
  { weekday: 4, startMinute: MIN(17), endMinute: MIN(16) + 1440 }, // Thu 17:00 -> Fri 16:00
];

/** Equity index futures additionally halt for 15 minutes around the cash close. */
/**
 * Mon-Thu only: the 16:00 CT close on Friday is the weekly close, after which the
 * market stays shut until Sunday evening. Calling that "maintenance" would tell a
 * trader the market reopens in an hour.
 */
const DAILY_BREAK: MaintenanceWindow = {
  label: 'Daily maintenance',
  weekdays: [1, 2, 3, 4],
  startMinute: MIN(16),
  endMinute: MIN(17),
};

const EQUITY_INDEX_MAINTENANCE: readonly MaintenanceWindow[] = [
  DAILY_BREAK,
  { label: 'Equity index halt', weekdays: [1, 2, 3, 4, 5], startMinute: MIN(15, 15), endMinute: MIN(15, 30) },
];

const STANDARD_MAINTENANCE: readonly MaintenanceWindow[] = [DAILY_BREAK];

/** Regular (pit-equivalent) hours in exchange local time, used for session shading. */
const RTH_EQUITY = { startMinute: MIN(8, 30), endMinute: MIN(15, 15) }; // 09:30-16:15 ET
const RTH_METALS = { startMinute: MIN(7, 20), endMinute: MIN(12, 30) }; // 08:20-13:30 ET
const RTH_ENERGY = { startMinute: MIN(8, 0), endMinute: MIN(13, 30) }; // 09:00-14:30 ET

const ALL_ORDER_TYPES = [
  'MARKET',
  'LIMIT',
  'STOP_MARKET',
  'STOP_LIMIT',
  'TRAILING_STOP',
] as const;

const EQUITY_ROLL = {
  cycle: { kind: 'QUARTERLY' } as const,
  expiry: { kind: 'THIRD_FRIDAY' } as const,
  rollDaysBeforeExpiry: 8,
};

/** COMEX gold: active delivery months Feb, Apr, Jun, Aug, Oct, Dec. */
const GOLD_ROLL = {
  cycle: { kind: 'CUSTOM', months: [2, 4, 6, 8, 10, 12] } as const,
  expiry: { kind: 'BUSINESS_DAYS_BEFORE_MONTH_END', businessDays: 3 } as const,
  rollDaysBeforeExpiry: 5,
};

/** NYMEX crude: every month; terminates 3 business days before the 25th of the prior month. */
const CRUDE_ROLL = {
  cycle: { kind: 'MONTHLY' } as const,
  expiry: { kind: 'BUSINESS_DAYS_BEFORE_DAY', businessDays: 3, dayOfMonth: 25 } as const,
  rollDaysBeforeExpiry: 2,
};

const CHICAGO = 'America/Chicago';
const GLOBEX_LABEL = 'Sun 17:00 - Fri 16:00 CT (60-min daily break)';

/** Full-size contract commissions, per side, per contract, in micro-dollars. */
const FULL_COMMISSION = 1_240_000; // $1.24
const MICRO_COMMISSION = 370_000; // $0.37
const FULL_EXCHANGE_FEES = 1_450_000; // $1.45
const MICRO_EXCHANGE_FEES = 370_000; // $0.37

export const INSTRUMENTS: readonly InstrumentSpec[] = [
  {
    root: 'NQ',
    displayName: 'NQ',
    description: 'E-mini Nasdaq-100 Index Futures',
    exchange: 'CME',
    assetClass: 'EQUITY_INDEX',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 25, // 0.25 index points
    pointValueMicros: 20_000_000, // $20.00 per index point
    tickValueMicros: 5_000_000, // $5.00 per tick
    contractMultiplier: 20,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: EQUITY_INDEX_MAINTENANCE,
    regularHours: RTH_EQUITY,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: EQUITY_ROLL,
    commissionPerSideMicros: FULL_COMMISSION,
    exchangeFeesPerSideMicros: FULL_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 200,
    providerSymbols: { yahoo: 'NQ=F' },
    isMicro: false,
  },
  {
    root: 'MNQ',
    displayName: 'MNQ',
    description: 'Micro E-mini Nasdaq-100 Index Futures',
    exchange: 'CME',
    assetClass: 'EQUITY_INDEX',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 25,
    pointValueMicros: 2_000_000, // $2.00 per index point
    tickValueMicros: 500_000, // $0.50 per tick
    contractMultiplier: 2,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: EQUITY_INDEX_MAINTENANCE,
    regularHours: RTH_EQUITY,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: EQUITY_ROLL,
    commissionPerSideMicros: MICRO_COMMISSION,
    exchangeFeesPerSideMicros: MICRO_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 2000,
    providerSymbols: { yahoo: 'NQ=F' },
    isMicro: true,
    fullSizeRoot: 'NQ',
  },
  {
    root: 'ES',
    displayName: 'ES',
    description: 'E-mini S&P 500 Index Futures',
    exchange: 'CME',
    assetClass: 'EQUITY_INDEX',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 25, // 0.25 index points
    pointValueMicros: 50_000_000, // $50.00 per index point
    tickValueMicros: 12_500_000, // $12.50 per tick
    contractMultiplier: 50,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: EQUITY_INDEX_MAINTENANCE,
    regularHours: RTH_EQUITY,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: EQUITY_ROLL,
    commissionPerSideMicros: FULL_COMMISSION,
    exchangeFeesPerSideMicros: FULL_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 200,
    providerSymbols: { yahoo: 'ES=F' },
    isMicro: false,
  },
  {
    root: 'MES',
    displayName: 'MES',
    description: 'Micro E-mini S&P 500 Index Futures',
    exchange: 'CME',
    assetClass: 'EQUITY_INDEX',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 25,
    pointValueMicros: 5_000_000, // $5.00 per index point
    tickValueMicros: 1_250_000, // $1.25 per tick
    contractMultiplier: 5,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: EQUITY_INDEX_MAINTENANCE,
    regularHours: RTH_EQUITY,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: EQUITY_ROLL,
    commissionPerSideMicros: MICRO_COMMISSION,
    exchangeFeesPerSideMicros: MICRO_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 2000,
    providerSymbols: { yahoo: 'ES=F' },
    isMicro: true,
    fullSizeRoot: 'ES',
  },
  {
    root: 'GC',
    displayName: 'GC',
    description: 'Gold Futures (100 troy ounces)',
    exchange: 'COMEX',
    assetClass: 'METALS',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 10, // $0.10 per troy ounce
    pointValueMicros: 100_000_000, // $100.00 per $1.00 move
    tickValueMicros: 10_000_000, // $10.00 per tick
    contractMultiplier: 100,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: STANDARD_MAINTENANCE,
    regularHours: RTH_METALS,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: GOLD_ROLL,
    commissionPerSideMicros: FULL_COMMISSION,
    exchangeFeesPerSideMicros: FULL_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 100,
    providerSymbols: { yahoo: 'GC=F' },
    isMicro: false,
  },
  {
    root: 'MGC',
    displayName: 'MGC',
    description: 'Micro Gold Futures (10 troy ounces)',
    exchange: 'COMEX',
    assetClass: 'METALS',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 10, // $0.10 per troy ounce
    pointValueMicros: 10_000_000, // $10.00 per $1.00 move
    tickValueMicros: 1_000_000, // $1.00 per tick
    contractMultiplier: 10,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: STANDARD_MAINTENANCE,
    regularHours: RTH_METALS,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: GOLD_ROLL,
    commissionPerSideMicros: MICRO_COMMISSION,
    exchangeFeesPerSideMicros: MICRO_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 1000,
    providerSymbols: { yahoo: 'GC=F' },
    isMicro: true,
    fullSizeRoot: 'GC',
  },
  {
    root: 'CL',
    displayName: 'CL',
    description: 'Light Sweet Crude Oil Futures (1,000 barrels)',
    exchange: 'NYMEX',
    assetClass: 'ENERGY',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 1, // $0.01 per barrel
    pointValueMicros: 1_000_000_000, // $1,000.00 per $1.00 move
    tickValueMicros: 10_000_000, // $10.00 per tick
    contractMultiplier: 1000,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: STANDARD_MAINTENANCE,
    regularHours: RTH_ENERGY,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: CRUDE_ROLL,
    commissionPerSideMicros: FULL_COMMISSION,
    exchangeFeesPerSideMicros: FULL_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 100,
    providerSymbols: { yahoo: 'CL=F' },
    // Crude settled below zero on 20 April 2020; that print is real.
    allowsNegativePrice: true,
    isMicro: false,
  },
  {
    root: 'MCL',
    displayName: 'MCL',
    description: 'Micro WTI Crude Oil Futures (100 barrels)',
    exchange: 'NYMEX',
    assetClass: 'ENERGY',
    currency: 'USD',
    pricePrecision: 2,
    tickSizeScaled: 1, // $0.01 per barrel
    pointValueMicros: 100_000_000, // $100.00 per $1.00 move
    tickValueMicros: 1_000_000, // $1.00 per tick
    contractMultiplier: 100,
    sessionTimezone: CHICAGO,
    sessionLabel: GLOBEX_LABEL,
    sessionWindows: GLOBEX_WINDOWS,
    maintenanceWindows: STANDARD_MAINTENANCE,
    regularHours: RTH_ENERGY,
    supportedOrderTypes: ALL_ORDER_TYPES,
    rollRule: CRUDE_ROLL,
    commissionPerSideMicros: MICRO_COMMISSION,
    exchangeFeesPerSideMicros: MICRO_EXCHANGE_FEES,
    minOrderQty: 1,
    maxOrderQty: 1000,
    providerSymbols: { yahoo: 'CL=F' },
    // Crude settled below zero on 20 April 2020; that print is real.
    allowsNegativePrice: true,
    isMicro: true,
    fullSizeRoot: 'CL',
  },
];

const BY_ROOT: ReadonlyMap<string, InstrumentSpec> = new Map(
  INSTRUMENTS.map((i) => [i.root, i]),
);

export function getInstrument(root: string): InstrumentSpec | undefined {
  return BY_ROOT.get(root.toUpperCase());
}

/** Throws for unknown symbols. Use in engine paths where absence is a bug. */
export function requireInstrument(root: string): InstrumentSpec {
  const spec = getInstrument(root);
  if (!spec) throw new Error(`UNKNOWN_INSTRUMENT: ${root}`);
  return spec;
}

export function listInstruments(): readonly InstrumentSpec[] {
  return INSTRUMENTS;
}
