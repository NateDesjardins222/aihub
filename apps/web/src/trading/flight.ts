/**
 * Orders that are in the air.
 *
 * Between a trader pressing BUY and the server saying what happened there is a
 * real interval, and Atlas has never modelled it: the ticket set one boolean
 * for the whole round trip, so "I have asked", "the server has it" and "it
 * filled" were the same state on screen. They are not the same thing, and the
 * difference is exactly what a trader needs when the answer is slow.
 *
 * So a FLIGHT is the client's record of its own intent - and only of its own
 * intent. It never carries a price, a fill or a P&L, because those are the
 * server's to say. It is superseded the moment authoritative state arrives.
 *
 * It also solves duplicate submission properly. The server's idempotency is
 * keyed on `clientOrderId`, and the ticket used to mint a fresh one on every
 * click - which meant two clicks were two different keys and therefore two
 * real orders, with the one mechanism that could have stopped it thrown away
 * at the door. Here, an intent that is already in the air is JOINED rather
 * than sent again: same key, same promise, one order.
 *
 * The coalescing window is the flight itself and nothing longer. A trader who
 * clicks BUY twice after the first order is acknowledged means two orders -
 * that is how scaling into a position is done - and a platform that swallows
 * the second one because it arrived quickly is worse than one that sends both.
 */
import { create } from 'zustand';
import { serverMsOfLastRequest } from '../api/client';
import { newClientOrderId } from './api';
import { execLatency } from './exec-latency';
import { tradingAudio } from '../audio/trading-audio';

export type FlightPhase = 'SENDING' | 'ACKNOWLEDGED' | 'REJECTED';

export interface Flight {
  /** The idempotency key this attempt was sent under. */
  readonly id: string;
  /** What the trader asked for, as a coalescing key. */
  readonly intent: string;
  /** Human-readable, for the pending row: "BUY 3 NQ". */
  readonly label: string;
  readonly accountId: string;
  readonly symbol: string;
  readonly phase: FlightPhase;
  readonly startedAt: number;
  /** Milliseconds from the click to the server's answer. */
  readonly ackMs: number | null;
  readonly error: string | null;
}

interface FlightState {
  readonly flights: readonly Flight[];
  /** Flights that reached the server, kept briefly so the UI can settle. */
  add(flight: Flight): void;
  update(id: string, patch: Partial<Flight>): void;
  drop(id: string): void;
  /** Everything in the air for one account, oldest first. */
  clear(accountId?: string): void;
}

export const useFlights = create<FlightState>((set) => ({
  flights: [],
  add: (flight) => set((state) => ({ flights: [...state.flights, flight] })),
  update: (id, patch) =>
    set((state) => ({
      flights: state.flights.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    })),
  drop: (id) => set((state) => ({ flights: state.flights.filter((f) => f.id !== id) })),
  clear: (accountId) =>
    set((state) => ({
      flights: accountId ? state.flights.filter((f) => f.accountId !== accountId) : [],
    })),
}));

/**
 * How long a rejected flight stays on screen.
 *
 * Long enough to read, short enough that it is gone before the next decision.
 * An accepted one is removed as soon as the server's answer lands, because
 * from that moment the order itself is the truth and a second row saying the
 * same thing in fainter type is just noise.
 */
const REJECTION_LINGER_MS = 6_000;
const ACCEPTED_LINGER_MS = 400;

/** Intents currently in the air, so a second press joins rather than sends. */
const inFlight = new Map<string, Promise<unknown>>();

export interface IntentSpec {
  /** Coalescing key: identical presses of the same button collapse. */
  readonly intent: string;
  readonly label: string;
  readonly accountId: string;
  readonly symbol: string;
  /** Prefix for the idempotency key, e.g. `ticket` or `chart`. */
  readonly prefix: string;
  /** `event.timeStamp` of the press, so the handler's own delay is counted. */
  readonly pressedAt?: number;
}

export interface IntentResult<T> {
  /** Null when this press joined one already in the air. */
  readonly value: T | null;
  readonly coalesced: boolean;
  readonly ackMs: number;
}

/**
 * Send one intent, once.
 *
 * The map is checked and written SYNCHRONOUSLY, before any await, which is the
 * whole point: two clicks dispatched in the same task - a double click, a
 * button and its hotkey together, a touch that fired both - reach this line
 * one after the other with nothing in between, and the second one finds the
 * first already there.
 */
export async function sendIntent<T>(
  spec: IntentSpec,
  work: (clientOrderId: string) => Promise<T>,
): Promise<IntentResult<T>> {
  const existing = inFlight.get(spec.intent);
  if (existing) {
    await existing.catch(() => undefined);
    return { value: null, coalesced: true, ackMs: 0 };
  }

  const id = newClientOrderId(spec.prefix);
  const startedAt = Date.now();
  execLatency.pressed(id, spec.pressedAt);
  const store = useFlights.getState();
  store.add({
    id,
    intent: spec.intent,
    label: spec.label,
    accountId: spec.accountId,
    symbol: spec.symbol,
    phase: 'SENDING',
    startedAt,
    ackMs: null,
    error: null,
  });

  execLatency.sent(id);
  const task = work(id);
  inFlight.set(spec.intent, task);
  try {
    const value = await task;
    const ackMs = Date.now() - startedAt;
    execLatency.acknowledged(id, serverMsOfLastRequest());
    useFlights.getState().update(id, { phase: 'ACKNOWLEDGED', ackMs });
    window.setTimeout(() => useFlights.getState().drop(id), ACCEPTED_LINGER_MS);
    return { value, coalesced: false, ackMs };
  } catch (error) {
    const ackMs = Date.now() - startedAt;
    execLatency.refused(id, serverMsOfLastRequest());
    /*
     * A refusal IS a server event.
     *
     * Most rejections never become an order row - the engine refuses them
     * before anything is persisted - so the state diff cannot see them. This
     * is still the server's answer and not the click's, which is the rule
     * that matters: Atlas says "rejected" because the server said no, not
     * because a button was pressed.
     */
    tradingAudio.play('ORDER_REJECTED');
    useFlights.getState().update(id, {
      phase: 'REJECTED',
      ackMs,
      error: error instanceof Error ? error.message : 'Request failed.',
    });
    window.setTimeout(() => useFlights.getState().drop(id), REJECTION_LINGER_MS);
    throw error;
  } finally {
    inFlight.delete(spec.intent);
  }
}

/** Is anything in the air for this intent right now? For disabling controls. */
export function intentInFlight(intent: string): boolean {
  return inFlight.has(intent);
}

/** Test seam: the number of intents currently in the air. */
export function flightCount(): number {
  return inFlight.size;
}
