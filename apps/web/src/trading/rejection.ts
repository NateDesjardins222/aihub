/**
 * Why an order was refused, in a sentence.
 *
 * The server already answers this honestly - a machine-readable reason and a
 * human one - and the terminal used to print the machine's answer in front of
 * the human's: "MAX CONTRACTS EXCEEDED: This account is limited to 3
 * contracts." Two statements of the same fact, one of them shouting.
 *
 * So the code chooses a short lead, and the server's own sentence follows it.
 * The lead is deliberately plain: a trader who has just been refused wants to
 * know what to do next, not to be told off. Where Atlas does NOT recognise the
 * code, the server's sentence stands on its own rather than being decorated
 * with an enum a trader cannot act on.
 */
import { ApiRequestError } from '../api/client';

/** Reason code to the words a trader would use for it. */
const LEAD: Record<string, string> = {
  MARKET_CLOSED: 'Market closed',
  MARKET_DATA_STALE: 'Stale market data',
  MARKET_DATA_UNAVAILABLE: 'No market data',
  POSITION_FROM_ANOTHER_MARKET: 'Position from another market',
  ACCOUNT_LOCKED: 'Account locked',
  ACCOUNT_FAILED: 'Account failed',
  ACCOUNT_NOT_FOUND: 'No such account',
  MAX_CONTRACTS_EXCEEDED: 'Too many contracts',
  INSUFFICIENT_RISK_CAPACITY: 'No risk capacity left',
  INSTRUMENT_NOT_PERMITTED: 'Instrument not permitted',
  UNSUPPORTED_ORDER_TYPE: 'Order type not supported',
  INVALID_QUANTITY: 'Invalid quantity',
  INVALID_PRICE: 'Invalid price',
  INVALID_TICK: 'Off the tick',
  MISSING_LIMIT_PRICE: 'Needs a limit price',
  MISSING_STOP_PRICE: 'Needs a stop price',
  STOP_ON_WRONG_SIDE: 'Stop on the wrong side',
  PROTECTION_ON_WRONG_SIDE: 'Protection on the wrong side',
  ORDER_NOT_FOUND: 'Order already gone',
  ORDER_NOT_MODIFIABLE: 'Order already completed',
  UNKNOWN_INSTRUMENT: 'Unknown instrument',
};

/**
 * A refusal the trader can read.
 *
 * Never a stack trace, never a status code on its own, and never the word
 * "failed" when Atlas knows better. A connection that never answered is its
 * own case: nothing was refused, so nothing should claim it was.
 */
export function describeRejection(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const lead = LEAD[error.code];
    if (lead) return `${lead} — ${error.message}`;
    // An unmapped code: the server's sentence is better than its enum.
    return error.message || 'The order was refused.';
  }
  if (error instanceof TypeError) {
    // fetch() rejects with a TypeError when the request never reached anyone.
    return 'Connection unavailable — the order was not sent.';
  }
  return error instanceof Error && error.message ? error.message : 'The order was refused.';
}

/** The lead alone, for somewhere there is no room for a sentence. */
export function rejectionLead(code: string): string {
  return LEAD[code] ?? 'Refused';
}
