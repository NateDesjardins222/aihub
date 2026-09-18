/**
 * WebSocket protocol.
 *
 * One multiplexed socket. Every server frame carries a monotonic `seq` scoped to
 * its stream, so a client can detect a gap and request an authoritative snapshot
 * rather than silently diverging.
 */

import type {
  ConnectionStatus,
  NormalizedBar,
  NormalizedDepth,
  NormalizedQuote,
  NormalizedTrade,
  Timeframe,
} from './marketdata.js';
import type { Execution, Order, PositionView, Trade } from './trading.js';
import type { AccountView } from './account.js';

export type ChannelName =
  | `md.quote.${string}`
  | `md.trade.${string}`
  | `md.bar.${string}`
  | `md.depth.${string}`
  | 'md.status'
  | `acct.${string}.orders`
  | `acct.${string}.executions`
  | `acct.${string}.positions`
  | `acct.${string}.pnl`
  | `acct.${string}.risk`
  | `acct.${string}.status`
  | 'sys.heartbeat';

export interface ClientHello {
  readonly t: 'hello';
  readonly token: string;
  readonly clientId: string;
  readonly protocolVersion: 1;
}

export interface ClientSubscribe {
  readonly t: 'subscribe';
  readonly channels: readonly string[];
}

export interface ClientUnsubscribe {
  readonly t: 'unsubscribe';
  readonly channels: readonly string[];
}

/** Ask the server to resume a stream from lastSeq, or send a snapshot if it cannot. */
export interface ClientResume {
  readonly t: 'resume';
  readonly stream: string;
  readonly lastSeq: number;
}

export interface ClientPing {
  readonly t: 'ping';
  readonly ts: number;
}

export interface ClientBarSubscribe {
  readonly t: 'bars';
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly action: 'subscribe' | 'unsubscribe';
}

export type ClientFrame =
  | ClientHello
  | ClientSubscribe
  | ClientUnsubscribe
  | ClientResume
  | ClientPing
  | ClientBarSubscribe;

export interface ServerWelcome {
  readonly t: 'welcome';
  readonly serverTime: number;
  readonly sessionId: string;
  readonly userId: string;
  readonly protocolVersion: 1;
}

export interface ServerPong {
  readonly t: 'pong';
  /** Echo of the client's ts, for round-trip latency measurement. */
  readonly ts: number;
  readonly serverTime: number;
}

export interface ServerError {
  readonly t: 'error';
  readonly code: string;
  readonly message: string;
}

/** A gap was detected or a resume was impossible: replace local state entirely. */
export interface ServerSnapshot<T = unknown> {
  readonly t: 'snapshot';
  readonly stream: string;
  readonly seq: number;
  readonly serverTime: number;
  readonly data: T;
}

export interface ServerDelta<T = unknown> {
  readonly t: 'delta';
  readonly stream: string;
  readonly seq: number;
  readonly serverTime: number;
  /**
   * When the vendor response carrying this observation was parsed by the
   * server, for measuring the wire-to-paint half of the latency path against
   * the same instant the server measured its own half against.
   *
   * Absent on frames that carry no market observation.
   */
  readonly observedAt?: number;
  readonly data: T;
}

export interface ServerHeartbeat {
  readonly t: 'heartbeat';
  readonly serverTime: number;
  readonly marketData: ConnectionStatus;
  readonly backlog: number;
}

export type ServerFrame =
  | ServerWelcome
  | ServerPong
  | ServerError
  | ServerSnapshot
  | ServerDelta
  | ServerHeartbeat;

/** Typed payloads carried by delta frames, keyed by stream prefix. */
export interface StreamPayloads {
  quote: NormalizedQuote;
  trade: NormalizedTrade;
  bar: NormalizedBar;
  depth: NormalizedDepth;
  status: ConnectionStatus;
  orders: Order;
  executions: Execution;
  positions: PositionView;
  pnl: AccountView;
  trades: Trade;
}
