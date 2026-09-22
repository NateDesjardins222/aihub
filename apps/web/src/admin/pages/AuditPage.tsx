/**
 * The audit explorer.
 *
 * Atlas keeps an append-only, hash-chained audit log; this is the operator's
 * window into it. Filter by action, actor, subject type and time; page through
 * with a stable cursor. Clicking a row expands its before/after metadata (safe
 * fields only — the recorder never writes secrets). Every figure is the
 * server's.
 */
import { Fragment, useCallback, useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Panel, usePagedList, when, type AdminRouteGo } from '../shared';
import type { AuditEntry } from '../types';

const SUBJECT_TYPES = ['', 'ACCOUNT', 'USER', 'PROFILE', 'ORDER', 'ORGANIZATION'] as const;

export function AdminAuditPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [subjectType, setSubjectType] = useState('');
  const [applied, setApplied] = useState({ action: '', actor: '', subjectType: '' });
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const res = await adminApi.auditExplorer({ ...applied, cursor });
      return { items: res.entries, nextCursor: res.nextCursor };
    },
    [applied],
  );
  const { items, error, loading, loadingMore, nextCursor, loadMore } = usePagedList<AuditEntry>(
    fetchPage,
    [applied],
  );

  return (
    <div className="adm-page">
      <Panel
        title="Audit"
        action={
          <form
            className="adm-search"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied({ action: action.trim(), actor: actor.trim(), subjectType });
            }}
          >
            <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action" aria-label="Action" />
            <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Actor" aria-label="Actor" />
            <select className="adm-input" value={subjectType} onChange={(e) => setSubjectType(e.target.value)} aria-label="Subject type">
              {SUBJECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === '' ? 'any subject' : t.toLowerCase()}
                </option>
              ))}
            </select>
            <button className="adm-btn" type="submit">
              Filter
            </button>
          </form>
        }
      >
        {error ? <p className="adm-error">Unable to load — {error}</p> : null}
        {loading ? <p className="adm-muted">Loading…</p> : null}
        {!loading ? (
          <table className="adm-table" data-testid="admin-audit">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Subject</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <Fragment key={e.id}>
                  <tr className="adm-row-click" onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                    <td className="num adm-dim">{when(e.at)}</td>
                    <td>{e.action}</td>
                    <td className="adm-dim">{e.actor.label ?? e.actor.type.toLowerCase()}</td>
                    <td className="adm-dim">
                      {e.subjectType.toLowerCase()}
                      {e.accountId ? (
                        <button
                          className="adm-link"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            go({ name: 'ACCOUNT', id: e.accountId! });
                          }}
                        >
                          {' ↗'}
                        </button>
                      ) : null}
                    </td>
                    <td className="adm-dim">{e.reason ?? '—'}</td>
                  </tr>
                  {expanded === e.id ? (
                    <tr className="adm-subrow">
                      <td colSpan={5}>
                        <pre className="adm-audit-json">
                          {JSON.stringify({ prev: e.prevState, next: e.newState }, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="adm-muted">
                    No audit records match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
        <div className="adm-more">
          <span className="adm-dim">
            Showing {items.length}
            {nextCursor ? '+' : ''} record{items.length === 1 ? '' : 's'}
          </span>
          {nextCursor ? (
            <button className="adm-btn" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
