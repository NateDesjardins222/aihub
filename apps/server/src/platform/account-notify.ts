/**
 * Cross-process wake-up over PostgreSQL LISTEN/NOTIFY.
 *
 * When one Atlas instance changes an account, the outbox worker issues a NOTIFY.
 * Every instance LISTENs, so an instance holding a trader's or owner's WebSocket
 * learns of a change processed elsewhere and re-publishes the current state.
 *
 * This is a TRANSIENT wake-up, never a source of truth. If a notification is
 * lost (a listener was down, the payload was dropped), the durable projection
 * and outbox still hold the truth and the next read or the next event converges.
 * Redis is deliberately not used: Postgres already delivers this, and adding
 * Redis would introduce a second place that could disagree with the database.
 */
import type postgres from 'postgres';

export const ACCOUNT_CHANGED_CHANNEL = 'atlas_account_changed';

export interface AccountChangeListener {
  close(): Promise<void>;
}

/**
 * Start listening for account-changed notifications on a dedicated connection.
 * `onChange` is called with each account id. Errors in `onChange` are swallowed
 * so one bad handler cannot stop the listener.
 */
export async function listenAccountChanged(
  pg: postgres.Sql,
  onChange: (accountId: string) => void,
): Promise<AccountChangeListener> {
  const subscription = await pg.listen(ACCOUNT_CHANGED_CHANNEL, (payload) => {
    if (!payload) return;
    try {
      onChange(payload);
    } catch {
      /* a bad handler must not stop the stream */
    }
  });
  return {
    close: () => subscription.unlisten(),
  };
}
