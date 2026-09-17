/** Every trader on the platform, searchable by name or e-mail. */
import { useState, type JSX } from 'react';
import { adminApi } from '../api';
import { Panel, StatusPill, useLoad, when, type AdminRouteGo, type AdminUser } from '../shared';

export function AdminUsersPage({ go }: { go: AdminRouteGo }): JSX.Element {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const { data, error, loading } = useLoad<{ users: AdminUser[] }>(
    () => adminApi.users(query),
    [query],
  );

  return (
    <div className="adm-page">
      <Panel
        title="Users"
        action={
          <form
            className="adm-search"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(term.trim());
            }}
          >
            <input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search name or e-mail"
              aria-label="Search users"
            />
            <button className="adm-btn" type="submit">
              Search
            </button>
          </form>
        }
      >
        {error ? <p className="adm-error">{error}</p> : null}
        {!data && loading ? <p className="adm-muted">Loading…</p> : null}
        {data ? (
          <table className="adm-table" data-testid="admin-users">
            <thead>
              <tr>
                <th>Name</th>
                <th>E-mail</th>
                <th>Role</th>
                <th>Status</th>
                <th className="num">Accounts</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => (
                <tr
                  key={user.id}
                  className="adm-row-click"
                  onClick={() => go({ name: 'USER', id: user.id })}
                >
                  <td>{user.displayName}</td>
                  <td className="adm-dim">{user.email}</td>
                  <td>{user.role.replace('_', ' ').toLowerCase()}</td>
                  <td>
                    <StatusPill status={user.status} />
                  </td>
                  <td className="num">{user.accountCount ?? '—'}</td>
                  <td className="num adm-dim">{when(user.lastLoginAt)}</td>
                </tr>
              ))}
              {data.users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="adm-muted">
                    No users match that.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  );
}
