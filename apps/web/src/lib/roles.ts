/**
 * Who may open the Owner Console (the operator app at /admin).
 *
 * This mirrors the server's authority and AdminApp's own gate EXACTLY: the
 * operator console denies a session only when its role resolves to TRADER, so
 * anyone else (SUPPORT / ADMIN / SUPER_ADMIN) may enter. The in-product
 * "Owner Console" entry points use this so a link is shown to precisely the
 * accounts that will be let in — a trader never sees it, and an operator is
 * never shown a link into a screen that would then deny them.
 *
 * This is a UI affordance only. It is NOT an authorization decision: the server
 * (`requireRole`) remains the sole authority for every operator route. A trader
 * who types /admin manually still reaches the honest denial screen.
 */
import type { ApiUser } from '../api/types';

/** The role AdminApp resolves a session to (role wins; legacy isAdmin is the fallback). */
export function resolveRole(user: ApiUser | null): 'TRADER' | 'SUPPORT' | 'ADMIN' | 'SUPER_ADMIN' {
  return user?.role ?? (user?.isAdmin ? 'ADMIN' : 'TRADER');
}

/** True when this session may open the Owner Console (anyone who is not a plain trader). */
export function canAccessOwnerConsole(user: ApiUser | null): boolean {
  return user != null && resolveRole(user) !== 'TRADER';
}
