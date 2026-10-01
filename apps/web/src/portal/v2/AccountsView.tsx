/**
 * V2AccountsView — the Accounts experience (Product Rebuild Phase 1, STEP 7/9).
 *
 * PRESENTATIONAL and pure: it takes a discriminated load state and renders it. It
 * never fetches (the container does) and never decides business truth (the adapter
 * maps authoritative state). Every data surface has a deliberate loading / empty /
 * error state, and a partial-failure note is distinct from an empty account list.
 * Renders inside a `.htv2` root supplied by the shell.
 */
import type { JSX } from 'react';
import type { AccountsView, AccountSummary } from '../lib';
import { V2AccountPanel } from './AccountPanel';
import { toAccountView, type AccountViewExtra } from './account-view';
import { V2Button, V2EmptyState, V2Section } from './primitives';
import './AccountsView.css';

/** Discriminated load state — the container maps fetch outcomes onto this. */
export type V2AccountsState =
  | { status: 'loading' }
  | { status: 'error'; message: string; onRetry?: () => void }
  | { status: 'ready'; view: AccountsView; degraded?: string | null };

export interface AccountsActions {
  onOpen?: (a: AccountSummary) => void;
  onTrade?: (a: AccountSummary) => void;
  onGetAccount?: () => void;
}

function SkeletonPanel(): JSX.Element {
  return <div className="htv2-acct htv2-acct-skeleton" aria-hidden><span /><span /><span /><span /></div>;
}

export function V2AccountsView({ state, actions = {}, extraFor }: {
  state: V2AccountsState;
  actions?: AccountsActions;
  /** Optional authoritative funded extras (winning days / consistency / payout) by account. */
  extraFor?: (a: AccountSummary) => AccountViewExtra | undefined;
}): JSX.Element {
  return (
    <V2Section
      title="Accounts"
      actions={
        state.status === 'ready' ? (
          <span className="ht-t-meta ht-num" data-testid="htv2-slots">
            {state.view.activeSlotsUsed} of {state.view.maxActiveSlots} active slots used
          </span>
        ) : undefined
      }
    >
      {state.status === 'loading' && (
        <div className="htv2-acct-grid" data-testid="htv2-accounts-loading" aria-busy="true">
          <SkeletonPanel />
          <SkeletonPanel />
        </div>
      )}

      {state.status === 'error' && (
        <div className="htv2-accounts-error" role="alert" data-testid="htv2-accounts-error">
          <div className="ht-t-section">We couldn’t load your accounts</div>
          <p className="ht-t-body-sm">{state.message}</p>
          {state.onRetry && <V2Button variant="secondary" size="sm" onClick={state.onRetry}>Try again</V2Button>}
        </div>
      )}

      {state.status === 'ready' && state.view.accounts.length === 0 && (
        <div data-testid="htv2-accounts-empty">
          <V2EmptyState
            title="No accounts yet"
            hint="Buy an evaluation to get started — your accounts and progress will appear here."
            action={<V2Button variant="primary" size="sm" onClick={actions.onGetAccount}>Get an account</V2Button>}
          />
        </div>
      )}

      {state.status === 'ready' && state.view.accounts.length > 0 && (
        <>
          {state.degraded && (
            <div className="htv2-accounts-degraded" role="status" data-testid="htv2-accounts-degraded">
              {state.degraded}
            </div>
          )}
          <div className="htv2-acct-grid" data-testid="htv2-accounts-grid">
            {state.view.accounts.map((a) => (
              <V2AccountPanel
                key={a.id}
                a={toAccountView(a, extraFor?.(a))}
                onDetails={actions.onOpen ? () => actions.onOpen!(a) : undefined}
                onTrade={actions.onTrade ? () => actions.onTrade!(a) : undefined}
              />
            ))}
          </div>
        </>
      )}
    </V2Section>
  );
}
