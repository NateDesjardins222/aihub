/**
 * V2AccountsContainer — the production-capable data container (Product Rebuild
 * Phase 1, STEP 7/19).
 *
 * Fetches the AUTHORITATIVE `/api/v1/portal/accounts` (owner-scoped, session-bound,
 * ownership enforced server-side) and hands the presentational V2AccountsView a
 * discriminated load state. This is the real integration seam: when the Accounts
 * surface is migrated into the authenticated portal, this container is what mounts.
 * It is NOT wired into the live V1 Portal in Phase 1 — V1 remains production truth
 * (clean rollback = do not switch the route). The dev harness renders the
 * presentational view with fixtures instead, so it needs no session.
 *
 * A monotonic request token discards a stale response (Phase B stale-response
 * discipline), so a slow reload never paints over a newer one.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api, ApiRequestError } from '../../api/client';
import type { AccountsView, AccountSummary } from '../lib';
import { V2AccountsView, type V2AccountsState } from './AccountsView';

export function V2AccountsContainer(): JSX.Element {
  const [state, setState] = useState<V2AccountsState>({ status: 'loading' });
  const tokenRef = useRef(0);

  const load = useCallback(() => {
    const token = ++tokenRef.current;
    setState({ status: 'loading' });
    void api
      .get<AccountsView>('/api/v1/portal/accounts?includeArchived=false')
      .then((view) => {
        if (token !== tokenRef.current) return; // a newer request superseded this one
        setState({ status: 'ready', view, degraded: null });
      })
      .catch((err: unknown) => {
        if (token !== tokenRef.current) return;
        const message =
          err instanceof ApiRequestError
            ? err.message
            : 'Something went wrong while loading your accounts. Please try again.';
        setState({ status: 'error', message, onRetry: load });
      });
  }, []);

  useEffect(() => load(), [load]);

  const openAccount = (a: AccountSummary): void => {
    window.location.href = `/portal/accounts/${a.id}`;
  };
  const trade = (a: AccountSummary): void => {
    // Same authoritative hand-off as V1: the server re-checks ownership + status.
    window.location.href = `/?account=${a.publicId}`;
  };
  const getAccount = (): void => {
    window.location.href = '/onboarding';
  };

  return (
    <V2AccountsView
      state={state}
      actions={{ onOpen: openAccount, onTrade: trade, onGetAccount: getAccount }}
    />
  );
}
