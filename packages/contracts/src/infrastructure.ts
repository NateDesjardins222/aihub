/**
 * Provider-neutral production-infrastructure contracts (Milestone 4).
 *
 * Atlas owns these types; providers are adapters that terminate at their own
 * boundaries. Nothing here is vendor-specific. These describe HOW Atlas talks
 * about market-data providers, execution providers, execution modes,
 * account↔provider mapping, the external order lifecycle, provider health, and
 * the market-data entitlement domain — without naming a vendor in a way that
 * couples the domain to it.
 */

// ---------------------------------------------------------------------------
// Data mode — the presentation-facing truth about the market feed.
// ---------------------------------------------------------------------------

/**
 * What the trader is looking at, as one honest label. Derived (never chosen in
 * the UI) from the provider's declared `mode` and its live connection/freshness:
 *  - REALTIME/DELAYED/REPLAY: the provider's declared relationship to the market
 *  - SIMULATED: no external market feed at all (should be shown as such)
 *  - STALE: a feed that exists but is older than its declared delay allows
 *  - DISCONNECTED: no live connection to the feed
 */
export type DataMode = 'REALTIME' | 'DELAYED' | 'REPLAY' | 'SIMULATED' | 'STALE' | 'DISCONNECTED';

// ---------------------------------------------------------------------------
// Exchange session authority (M4-I).
// ---------------------------------------------------------------------------

/**
 * The authoritative session state exposed by the Atlas SessionService. A superset
 * of the pure-calendar `MarketState`: adds HALTED (a known trading halt, when a
 * provider reports one) and UNKNOWN (authoritative status genuinely unavailable —
 * e.g. a date past the holiday-calendar coverage). If status is unavailable the
 * answer is UNKNOWN, never OPEN.
 */
export type SessionState = 'OPEN' | 'CLOSED' | 'PRE_OPEN' | 'MAINTENANCE' | 'HALTED' | 'UNKNOWN';

export interface SessionStatus {
  readonly root: string;
  readonly exchange: string;
  readonly state: SessionState;
  readonly reason: string;
  /** The Globex trading date this instant belongs to (YYYY-MM-DD), if resolvable. */
  readonly tradingDate: string | null;
  /** Exchange-local ISO time this was evaluated at. */
  readonly exchangeLocal: string | null;
  /** True when the calendar could authoritatively answer (else state = UNKNOWN). */
  readonly authoritative: boolean;
}

// ---------------------------------------------------------------------------
// Providers — kinds, capabilities, configuration + health state.
// ---------------------------------------------------------------------------

/** Market-data providers Atlas can be configured to use. Adapters, not the domain. */
export type MarketDataProviderKind = 'yahoo-delayed' | 'replay' | 'databento' | 'rithmic' | 'scripted';

/** Execution providers Atlas can route an account to. `simulation` is the default. */
export type ExecutionProviderKind = 'simulation' | 'rithmic' | 'scripted';

/**
 * A provider's own view of whether it can operate. UNCONFIGURED is a first-class,
 * boot-safe state: a professional provider that has no credentials reports
 * UNCONFIGURED and never CONNECTED — it does not fail the process.
 */
export type ProviderConfigState = 'UNCONFIGURED' | 'CONFIGURED';

/**
 * Operational health of a provider connection, coarser than the market-data
 * `ConnectionState` and shared by market-data and execution providers.
 */
export type ProviderHealthState =
  | 'UNCONFIGURED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'DISCONNECTED'
  | 'ERROR';

/** A capability a provider may or may not support; asked, never assumed. */
export type MarketDataCapability =
  | 'TRADES'
  | 'TOP_OF_BOOK'
  | 'MARKET_BY_PRICE'
  | 'MARKET_BY_ORDER'
  | 'OHLCV'
  | 'HISTORICAL'
  | 'INSTRUMENT_DEFINITIONS'
  | 'TRADING_STATUS';

/**
 * The structured error returned when a caller asks a provider for a capability
 * it has explicitly declared it does not support. There is NO silent fallback
 * from a professional realtime feed to the development feed.
 */
export interface CapabilityError {
  readonly kind: 'CAPABILITY_UNAVAILABLE';
  readonly providerId: string;
  readonly capability: MarketDataCapability;
  readonly message: string;
}

/** Redacted, secret-free provider health snapshot for owner/ops surfaces. */
export interface ProviderHealthSnapshot {
  readonly providerId: string;
  readonly role: 'MARKET_DATA' | 'EXECUTION';
  readonly kind: string;
  readonly configState: ProviderConfigState;
  readonly health: ProviderHealthState;
  readonly isSimulation: boolean;
  /** Coarse, human-readable, never a credential. */
  readonly detail: string;
  readonly lastConnectAt: number | null;
  readonly lastDisconnectAt: number | null;
  readonly lastMessageAt: number | null;
  readonly lastHeartbeatAt: number | null;
  readonly reconnectCount: number;
  readonly subscriptionCount: number;
  /** Last structured, redacted error string, if any. */
  readonly lastError: string | null;
}

// ---------------------------------------------------------------------------
// Execution modes + account ↔ provider mapping.
// ---------------------------------------------------------------------------

/**
 * How an account's orders are executed.
 *  - SIMULATION: the Atlas simulator (default; the only reachable mode in V1)
 *  - EXTERNAL_PAPER: a real external provider in paper/simulated-account mode
 *  - EXTERNAL_LIVE: a real external provider with real capital
 *
 * EXTERNAL_* modes require an explicit server-side administrative mapping and a
 * configured, connected provider. The browser can NEVER select a mode.
 */
export type ExecutionMode = 'SIMULATION' | 'EXTERNAL_PAPER' | 'EXTERNAL_LIVE';

export interface ProviderAccountMapping {
  readonly accountId: string;
  readonly executionMode: ExecutionMode;
  readonly executionProvider: ExecutionProviderKind;
  /** Provider environment label (e.g. "paper", "prod"), opaque to the domain. */
  readonly providerEnvironment: string | null;
  /** The provider's own account identifier. Never authoritative to the browser. */
  readonly providerAccountId: string | null;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly mappedAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// External order lifecycle (M4-N).
// ---------------------------------------------------------------------------

/**
 * The lifecycle of an order Atlas has sent to an EXTERNAL provider. Distinct
 * from Atlas's own `OrderStatus`: an HTTP/request success is NOT an exchange
 * acknowledgement, and Atlas must be able to represent "we don't know".
 */
export type ExternalOrderState =
  | 'PENDING_SUBMIT'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PENDING_CANCEL'
  | 'CANCELED'
  | 'REJECTED'
  | 'UNKNOWN';

export interface ExternalOrderView {
  /** Atlas's canonical order id — the only authority exposed to the browser. */
  readonly atlasOrderId: string;
  /** The provider's order id, stored separately, never authoritative to clients. */
  readonly providerOrderId: string | null;
  readonly accountId: string;
  readonly providerAccountId: string | null;
  readonly symbol: string;
  readonly contractCode: string | null;
  readonly requestedQty: number;
  readonly filledQty: number;
  readonly remainingQty: number;
  readonly avgFillPrice: number | null;
  readonly state: ExternalOrderState;
  /** The provider's own raw status string, kept for diagnosis. */
  readonly providerStatus: string | null;
  readonly submittedAt: number | null;
  readonly lastEventAt: number | null;
}

/** The result of a reconciliation pass over external orders/positions. */
export type ReconciliationState = 'IN_SYNC' | 'RECONCILIATION_REQUIRED' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Market-data entitlement domain (M4-S) — SOFTWARE domain only.
// Not legal advice, not permission to redistribute, not an exchange agreement.
// ---------------------------------------------------------------------------

export type EntitlementExchange = 'CME' | 'CBOT' | 'NYMEX' | 'COMEX';

/** Level of data an entitlement permits. Ascending capability. */
export type EntitlementDataLevel = 'DELAYED' | 'REALTIME_TOP' | 'REALTIME_DEPTH';

/** Whether data is used on a human display or by machines only. */
export type EntitlementDisplayUse = 'DISPLAY' | 'NON_DISPLAY';

export type EntitlementStatus = 'ENTITLED' | 'NOT_ENTITLED' | 'PENDING' | 'UNKNOWN';

export interface MarketDataEntitlement {
  readonly id: string;
  /** Null for a provider/exchange-wide entitlement; set for a specific user. */
  readonly userId: string | null;
  readonly exchange: EntitlementExchange;
  readonly dataLevel: EntitlementDataLevel;
  readonly displayUse: EntitlementDisplayUse;
  readonly status: EntitlementStatus;
  /** Opaque provider-side entitlement reference; never a credential. */
  readonly providerEntitlementRef: string | null;
  readonly effectiveAt: number | null;
  readonly expiresAt: number | null;
}
