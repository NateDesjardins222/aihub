/**
 * Shared pieces of the operator console.
 *
 * Small on purpose: a table, a panel, a statistic, a money figure and a
 * confirmation. The console is a tool for reading authoritative data and
 * occasionally acting on it, not a design exercise.
 */
import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';
import { formatMicros } from '../state/format';
import type { AdminRoute } from './AdminApp';
import type { AuditEntry } from './types';

export type { AdminOverview, AdminAccount, AdminUser, AuditEntry } from './types';
export type AdminRouteGo = (route: AdminRoute) => void;

/** Load once, expose a reload, and never leave a stale error on screen. */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

/**
 * A keyset-paginated list: the first page, then "Load more" pages appended.
 *
 * The server hands back a `nextCursor`; the client hands it straight back to
 * get the next page, and never counts or offsets. Changing the deps (a new
 * search term) starts the list over from the top.
 */
export function usePagedList<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
  deps: unknown[],
): {
  items: T[];
  error: string | null;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  loadMore: () => void;
} {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItems([]);
    setNextCursor(null);
    fetchPage(null)
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    fetchPage(nextCursor)
      .then((result) => {
        setItems((prev) => [...prev, ...result.items]);
        setNextCursor(result.nextCursor);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoadingMore(false));
  }, [nextCursor, loadingMore, fetchPage]);

  return { items, error, loading, loadingMore, nextCursor, loadMore };
}

export function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="adm-panel">
      <header className="adm-panel-head">
        <h2>{title}</h2>
        <div className="adm-spacer" />
        {action}
      </header>
      <div className="adm-panel-body">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}): JSX.Element {
  return (
    <div className="adm-stat">
      <span className="adm-stat-label">{label}</span>
      <span className="adm-stat-value">{value}</span>
      {sub ? <span className="adm-stat-sub">{sub}</span> : null}
    </div>
  );
}

export function Money({ micros, sign }: { micros: number; sign?: boolean }): JSX.Element {
  const text = formatMicros(micros, { sign });
  const tone = micros > 0 ? 'adm-pos' : micros < 0 ? 'adm-neg' : '';
  return <span className={`num ${sign ? tone : ''}`}>{text}</span>;
}

export function StatusPill({ status }: { status: string }): JSX.Element {
  return (
    <span className={`adm-pill adm-status-${status.toLowerCase()}`}>
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}

export function when(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AuditTable({
  entries,
  go,
}: {
  entries: AuditEntry[];
  go?: AdminRouteGo;
}): JSX.Element {
  if (entries.length === 0) return <p className="adm-muted">Nothing recorded yet.</p>;
  return (
    <table className="adm-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Action</th>
          <th>Actor</th>
          <th>Subject</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <td className="num adm-dim">{when(entry.at)}</td>
            <td>
              <code>{entry.action}</code>
            </td>
            <td>
              {entry.actor.label ?? entry.actor.type.toLowerCase()}
              <span className="adm-dim"> ({entry.actor.type.toLowerCase()})</span>
            </td>
            <td>
              {entry.accountId && go ? (
                <button
                  className="adm-link"
                  onClick={() => go({ name: 'ACCOUNT', id: entry.accountId! })}
                >
                  account
                </button>
              ) : entry.userId && go ? (
                <button className="adm-link" onClick={() => go({ name: 'USER', id: entry.userId! })}>
                  user
                </button>
              ) : (
                <span className="adm-dim">{entry.subjectType.toLowerCase()}</span>
              )}
            </td>
            <td className="adm-dim">{entry.reason ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Confirmation for anything destructive.
 *
 * The reason is not decoration: the server requires it, and it is what an
 * operator reads six months later when they are trying to work out why an
 * account was reset.
 */
export function ConfirmAction({
  title,
  description,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  return (
    <div className="adm-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="adm-dialog" data-testid="admin-confirm">
        <h3>{title}</h3>
        <p>{description}</p>
        <label className="adm-field">
          <span>Reason (recorded in the audit log)</span>
          <input
            value={reason}
            autoFocus
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this being done?"
          />
        </label>
        <div className="adm-dialog-actions">
          <button className="adm-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="adm-btn adm-btn-danger"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
