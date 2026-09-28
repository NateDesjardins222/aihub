/**
 * V2AccountDetailContainer — the production-capable detail data container (Product
 * Rebuild Phase 2, Parts III/XIII).
 *
 * Fetches the AUTHORITATIVE `/api/v1/portal/accounts/:id` (owner-scoped, ownership
 * enforced server-side) and hands the presentational detail a discriminated load
 * state. A monotonic request token (keyed to the account id) discards a stale
 * response, so rapidly switching A → B → A always ends on A's data even if B's
 * response arrives late. A 404 maps to a deliberate not-found state (the server
 * does not distinguish "missing" from "not yours" — no enumeration).
 *
 * NOT wired into the live V1 portal in Phase 2 — V1 remains production truth. The
 * dev harness renders the presentational detail with a fixture instead.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api, ApiRequestError } from '../../api/client';
import type { AccountDetailFull } from '../lib';
import { V2AccountDetail, type V2DetailState, type DetailTab } from './AccountDetail';
import { latestGuard } from './race';

export function V2AccountDetailContainer({
  accountId, tab, onTab, onBack,
}: {
  accountId: string; tab: DetailTab; onTab: (t: DetailTab) => void; onBack?: () => void;
}): JSX.Element {
  const [state, setState] = useState<V2DetailState>({ status: 'loading' });
  const guardRef = useRef(latestGuard());

  const load = useCallback(() => {
    const token = guardRef.current.issue();
    setState({ status: 'loading' });
    void api
      .get<AccountDetailFull>(`/api/v1/portal/accounts/${accountId}`)
      .then((detail) => {
        if (!guardRef.current.isLatest(token)) return; // a newer request (or account) superseded this one
        setState({ status: 'ready', detail });
      })
      .catch((err: unknown) => {
        if (!guardRef.current.isLatest(token)) return;
        if (err instanceof ApiRequestError && err.status === 404) {
          setState({ status: 'not-found' });
          return;
        }
        const message = err instanceof ApiRequestError ? err.message : 'Something went wrong loading this account. Please try again.';
        setState({ status: 'error', message, onRetry: load });
      });
  }, [accountId]);

  // Re-fetch whenever the account id changes; the token guard drops stale responses.
  useEffect(() => load(), [load]);

  const trade = (d: AccountDetailFull): void => {
    // The same authoritative hand-off as V1: the server re-checks ownership + status
    // for THIS account's publicId. A Trade click can never select another account.
    window.location.href = `/?account=${d.publicId}`;
  };

  return (
    <V2AccountDetail
      state={state}
      tab={tab}
      onTab={onTab}
      actions={{ onBack, onTrade: trade }}
    />
  );
}
