/**
 * The handoff notice.
 *
 * When the Portal's "Trade →" linked to a specific account (`/?account=<publicId>`)
 * but Atlas could not resolve that account against the trader's own list — it has
 * since been locked, failed, completed, or the link was stale — the terminal does
 * NOT silently open a different account as though the link had worked. It opens
 * the trader's fallback account AND says, here, exactly what happened and which
 * account it is showing instead. (Customer-system hardening §4A.)
 *
 * The account list Atlas read is owner-scoped, so a publicId that is not in it is
 * one the trader cannot currently trade — never another customer's account.
 */
import type { JSX } from 'react';
import { useSession, selectedAccount } from '../state/session';
import './HandoffNotice.css';

export function HandoffNotice(): JSX.Element | null {
  const requested = useSession((s) => s.handoffUnavailable);
  const showing = useSession(selectedAccount);
  const clear = useSession((s) => s.clearHandoffNotice);

  if (!requested) return null;

  return (
    <div className="handoff-notice" role="status" data-testid="atlas-handoff-unavailable">
      <span className="handoff-notice-text">
        The account you opened from the portal (<strong>{requested}</strong>) isn’t
        available to trade right now
        {showing ? (
          <>
            {' '}
            — showing <strong>{showing.name}</strong> instead.
          </>
        ) : (
          <> and you have no other account open.</>
        )}
      </span>
      <button
        type="button"
        className="handoff-notice-dismiss"
        onClick={clear}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
