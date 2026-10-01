/**
 * Account selection on load — the one decision the Portal→Atlas handoff turns on.
 *
 * Pure on purpose. The DOM side of a refresh (reading `?account=` from the URL,
 * persisting the choice to localStorage, pushing it into the store) lives in the
 * session store; the DECISION of which account a load should open, and whether an
 * explicit handoff was honoured, lives here where it can be proven exhaustively
 * without a browser.
 *
 * The invariant this enforces (customer-system hardening §4A):
 *
 *   If the Portal explicitly hands off account A (`/?account=<publicId>`), Atlas
 *   either selects A after verifying ownership, or it SAYS the requested account
 *   is unavailable. It never silently substitutes account B as though the handoff
 *   had succeeded.
 *
 * The account list this reads is already owner-scoped by the server, so finding a
 * handoff's publicId in it IS the ownership check — a publicId the caller does not
 * own simply is not present, and the fallback that follows is always to another
 * account the same owner holds.
 */
import type { ApiAccount } from '../api/types';

export interface AccountSelectionInput {
  /** The owner-scoped accounts returned by `/api/v1/accounts`. */
  readonly accounts: readonly ApiAccount[];
  /**
   * The `publicId` the Portal handoff requested for THIS load, already shape-
   * sanitised, or null when the load was not a handoff.
   */
  readonly handoff: string | null;
  /** The account id remembered from a previous manual selection, or null. */
  readonly remembered: string | null;
}

export interface AccountSelection {
  /** The account to open, or null when the owner holds no accounts at all. */
  readonly selectedAccountId: string | null;
  /**
   * The handoff `publicId` that was requested but could NOT be resolved against
   * the owner-scoped list. Non-null means the handoff did not succeed and the
   * UI must say so rather than present the fallback selection as the requested
   * account. Null whenever there was no handoff, or the handoff resolved.
   */
  readonly handoffUnavailable: string | null;
  /** True only when the selection is the verified target of an explicit handoff. */
  readonly handoffResolved: boolean;
}

/**
 * Decide which account a load opens, and whether an explicit handoff was honoured.
 *
 * A resolved handoff wins outright. When there is no handoff — or the handoff's
 * publicId is not in the owner-scoped list — selection falls back to the
 * remembered account, then a PRACTICE account, then the first account; but an
 * UNRESOLVED handoff is reported in `handoffUnavailable` so the caller never
 * passes the fallback off as the account the customer asked for.
 */
export function resolveAccountSelection(input: AccountSelectionInput): AccountSelection {
  const { accounts, handoff, remembered } = input;

  const handoffAccount = handoff
    ? (accounts.find((a) => a.publicId === handoff) ?? null)
    : null;

  // A verified handoff is authoritative: select exactly the requested account.
  if (handoff && handoffAccount) {
    return {
      selectedAccountId: handoffAccount.id,
      handoffUnavailable: null,
      handoffResolved: true,
    };
  }

  // Fallback — reached when there was no handoff, or the handoff could not be
  // verified against the owner-scoped list. With nothing remembered, open on a
  // PRACTICE account rather than whatever happens to be first: an evaluation
  // account has a drawdown and a daily loss limit, and a trader opening the
  // terminal to try something out should not meet those before their first order.
  const stillExists = remembered !== null && accounts.some((a) => a.id === remembered);
  const practice = accounts.find((a) => a.accountType === 'PRACTICE');
  const selectedAccountId = stillExists
    ? remembered
    : (practice?.id ?? accounts[0]?.id ?? null);

  return {
    selectedAccountId,
    // A handoff that was REQUESTED but not resolved must be surfaced, never
    // silently swapped for the fallback.
    handoffUnavailable: handoff && !handoffAccount ? handoff : null,
    handoffResolved: false,
  };
}
