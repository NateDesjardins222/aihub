/**
 * The owner Customer/Commerce console.
 *
 * Search a trader, then read their whole lifecycle — identity, contacts,
 * agreements, commerce orders, entitlements, accounts, notifications, audit —
 * with the exception queues and reconciliation that make operations
 * exception-driven. Every controlled action is RBAC-gated (the server enforces),
 * requires a reason, and is audited by the delegated service. Nothing here
 * computes state; every value came from the server.
 */
import { useCallback, useState, type JSX } from 'react';
import { adminApi, type CustomerDetail } from '../api';
import { ConfirmAction, Panel, StatusPill, useLoad, when } from '../shared';

type Pending =
  | { kind: 'retry'; orderId: string }
  | { kind: 'reverify'; id: string }
  | { kind: 'approve'; id: string }
  | { kind: 'reject'; id: string }
  | { kind: 'hold'; id: string; status: 'HOLD' | 'ACTIVE' }
  | { kind: 'resend'; id: string };

export function AdminCustomersPage({ mayMutate }: { mayMutate: boolean }): JSX.Element {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const exceptions = useLoad(() => adminApi.customerExceptions(), []);
  const recon = useLoad(() => adminApi.customerReconciliation(), []);
  const results = useLoad(() => adminApi.customers(term), [term]);
  const detail = useLoad(() => (selected ? adminApi.customer(selected) : Promise.resolve(null)), [selected]);

  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (reason: string) => {
      if (!pending) return;
      setBusy(true);
      try {
        if (pending.kind === 'retry') await adminApi.customerRetryProvisioning(pending.orderId, reason);
        if (pending.kind === 'reverify') await adminApi.customerRequireReverification(pending.id, reason);
        if (pending.kind === 'approve') await adminApi.customerReviewDecision(pending.id, 'IDENTITY_VERIFIED', reason);
        if (pending.kind === 'reject') await adminApi.customerReviewDecision(pending.id, 'REJECTED', reason);
        if (pending.kind === 'hold') await adminApi.customerHold(pending.id, pending.status, reason);
        if (pending.kind === 'resend') await adminApi.customerResendNotification(pending.id, reason);
        setPending(null);
        detail.reload();
        exceptions.reload();
        recon.reload();
      } catch {
        // The modal stays open; the row's state is unchanged.
      } finally {
        setBusy(false);
      }
    },
    [pending, detail, exceptions, recon],
  );

  const d = detail.data;
  const r = recon.data?.reconciliation;
  const counts = exceptions.data?.counts ?? {};

  return (
    <div className="adm-page" data-testid="admin-customers">
      <h1>Customers &amp; commerce</h1>

      <div className="adm-stats" data-testid="customer-exceptions">
        {Object.entries(counts).map(([k, v]) => (
          <div className="adm-stat" key={k}>
            <span className="adm-stat-label">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
            <span className="adm-stat-value">{v}</span>
          </div>
        ))}
      </div>

      <Panel
        title="Reconciliation"
        action={
          r ? (
            <span className={`adm-pill ${r.balanced ? 'adm-status-active' : 'adm-status-locked'}`} data-testid="recon-balanced">
              {r.balanced ? 'balanced' : 'discrepancies'}
            </span>
          ) : null
        }
      >
        {r ? (
          <div className="adm-stats">
            <Stat label="payment events received" value={r.paymentEventsReceived} />
            <Stat label="payment events processed" value={r.paymentEventsProcessed} />
            <Stat label="unreconciled payments" value={r.discrepancies.unreconciledPayments} />
            <Stat label="orders provisioned" value={r.orders.provisioned} />
            <Stat label="orders blocked" value={r.orders.blocked} />
            <Stat label="orders failed" value={r.orders.failed} />
            <Stat label="eval accounts" value={r.accounts.evaluation} />
            <Stat label="funded accounts" value={r.accounts.funded} />
          </div>
        ) : (
          <p className="adm-muted">{recon.error ?? 'Loading…'}</p>
        )}
      </Panel>

      <Panel title="Find a customer">
        <form
          className="adm-inline-actions"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(query.trim());
          }}
        >
          <input
            className="adm-input"
            data-testid="customer-search"
            placeholder="Search by email or name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="adm-btn adm-btn-primary" type="submit">
            Search
          </button>
        </form>
        {results.data && results.data.customers.length > 0 ? (
          <table className="adm-table" data-testid="customer-results">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Identity</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {results.data.customers.map((c) => (
                <tr key={c.customerIdentityId} data-testid={`customer-row-${c.customerIdentityId}`}>
                  <td>
                    <a
                      className="adm-link"
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setSelected(c.customerIdentityId);
                      }}
                    >
                      {c.email}
                    </a>
                  </td>
                  <td>{c.displayName}</td>
                  <td>
                    <StatusPill status={c.identityStatus} />
                  </td>
                  <td>
                    <StatusPill status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="adm-muted">{results.loading ? 'Loading…' : 'No customers match.'}</p>
        )}
      </Panel>

      {d ? <CustomerDetailView d={d} mayMutate={mayMutate} onAction={setPending} /> : null}

      {pending ? (
        <ConfirmAction
          title="Confirm action"
          description="This is recorded in the audit log."
          confirmLabel="Confirm"
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={run}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="adm-stat">
      <span className="adm-stat-label">{label}</span>
      <span className="adm-stat-value">{value}</span>
    </div>
  );
}

function CustomerDetailView({
  d,
  mayMutate,
  onAction,
}: {
  d: CustomerDetail;
  mayMutate: boolean;
  onAction: (p: Pending) => void;
}): JSX.Element {
  const inReview = d.identity.identityStatus === 'UNDER_REVIEW' || d.identity.identityStatus === 'STEP_UP_REQUIRED';
  return (
    <div data-testid="customer-detail">
      <Panel
        title={`${d.user?.email ?? 'Customer'} — identity`}
        action={
          <span className="adm-inline-actions">
            <StatusPill status={d.identity.identityStatus} />
            {mayMutate ? (
              <>
                <button className="adm-btn" onClick={() => onAction({ kind: 'reverify', id: d.identity.id })}>
                  Require reverification
                </button>
                {inReview ? (
                  <>
                    <button className="adm-btn" data-testid="review-approve" onClick={() => onAction({ kind: 'approve', id: d.identity.id })}>
                      Approve
                    </button>
                    <button className="adm-btn adm-btn-danger" onClick={() => onAction({ kind: 'reject', id: d.identity.id })}>
                      Reject
                    </button>
                  </>
                ) : null}
                <button
                  className="adm-btn"
                  onClick={() => onAction({ kind: 'hold', id: d.identity.id, status: d.identity.status === 'HOLD' ? 'ACTIVE' : 'HOLD' })}
                >
                  {d.identity.status === 'HOLD' ? 'Release hold' : 'Place hold'}
                </button>
              </>
            ) : null}
          </span>
        }
      >
        <div className="adm-stats">
          <Stat label="legal name" value={d.identity.legalName ?? '—'} />
          <Stat label="country" value={d.identity.country ?? '—'} />
          <Stat label="operational" value={<StatusPill status={d.identity.status} />} />
          <Stat label="identity provider" value={d.providers.identity} />
          <Stat label="commerce provider" value={d.providers.commerce} />
          <Stat label="email provider" value={d.providers.email} />
          <Stat label="sms provider" value={d.providers.sms} />
        </div>
      </Panel>

      <Panel title="Contacts">
        <SimpleTable
          rows={d.contacts.map((c) => [c.channel, c.value, c.status + (c.isPrimary ? ' (primary)' : '')])}
          head={['Channel', 'Value', 'Status']}
        />
      </Panel>

      <Panel title="Agreements">
        {d.outstandingAgreements.length > 0 ? (
          <p className="adm-error">Outstanding: {d.outstandingAgreements.map((a) => a.agreementType).join(', ')}</p>
        ) : (
          <p className="adm-muted">All required agreements accepted.</p>
        )}
        <SimpleTable
          rows={d.acceptances.map((a) => [a.agreementType, a.contentHash.slice(0, 12) + '…', when(Date.parse(a.acceptedAt))])}
          head={['Type', 'Content hash', 'Accepted']}
        />
      </Panel>

      <Panel title="Commerce — orders">
        <table className="adm-table" data-testid="customer-orders">
          <thead>
            <tr>
              <th>Status</th>
              <th>Source</th>
              <th>Note</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <StatusPill status={o.status} />
                </td>
                <td>{o.source}</td>
                <td className="adm-dim">{o.provisionNote ?? '—'}</td>
                <td>{when(Date.parse(o.createdAt))}</td>
                <td>
                  {mayMutate && (o.status === 'PROVISION_BLOCKED' || o.status === 'PROVISION_FAILED') ? (
                    <button
                      className="adm-btn"
                      data-testid={`retry-${o.id}`}
                      onClick={() => onAction({ kind: 'retry', orderId: o.id })}
                    >
                      Retry provisioning
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Entitlements">
        <SimpleTable
          rows={d.entitlements.map((e) => [e.kind, e.status, e.consumedByAccountId ? 'provisioned' : '—'])}
          head={['Kind', 'Status', 'Account']}
        />
      </Panel>

      <Panel title="Accounts">
        <SimpleTable
          rows={d.accounts.map((a) => [a.publicId, a.accountType, a.status, a.adminHold ?? '—'])}
          head={['Public id', 'Type', 'Status', 'Hold']}
        />
      </Panel>

      <Panel title="Copy trading">
        {d.copyGroups.length === 0 ? (
          <p className="adm-muted">No copy groups.</p>
        ) : (
          <div data-testid="customer-copy-groups">
            {d.copyGroups.map(({ group, sync, recentIntents }) => (
              <div key={group.id} className="adm-copy-group">
                <div className="adm-copy-head">
                  <strong>{group.name}</strong>
                  <StatusPill status={group.status} />
                  <span className="adm-dim">{group.sizingMode}</span>
                  {sync ? <StatusPill status={sync.status} /> : null}
                  {sync && sync.divergedAccountIds.length > 0 ? (
                    <span className="adm-error">{sync.divergedAccountIds.length} diverged</span>
                  ) : null}
                </div>
                <SimpleTable
                  rows={[
                    [
                      'LEADER',
                      group.leader ? `${group.leader.name} (${group.leader.publicId})` : '—',
                      group.leader?.status ?? '—',
                      group.leader?.eligible ? 'eligible' : 'ineligible',
                      '',
                    ],
                    ...group.followers.map((f) => [
                      'follower',
                      `${f.name} (${f.publicId})`,
                      f.status,
                      f.eligible ? 'eligible' : 'ineligible',
                      f.enabled ? 'enabled' : 'disabled',
                    ]),
                  ]}
                  head={['Role', 'Account', 'Status', 'Eligibility', 'State']}
                />
                {recentIntents.length > 0 ? (
                  <SimpleTable
                    rows={recentIntents.map((i) => [
                      i.kind,
                      `${i.accepted}✓ / ${i.rejected}✗ / ${i.skipped}⊘`,
                      i.rejections.length > 0
                        ? i.rejections.map((r) => `${r.publicId}:${r.code ?? '?'}`).join(', ')
                        : '—',
                    ])}
                    head={['Intent', 'Accepted/Rejected/Skipped', 'Rejections']}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Notifications">
        <table className="adm-table" data-testid="customer-notifications">
          <thead>
            <tr>
              <th>Type</th>
              <th>Channel</th>
              <th>Status</th>
              <th>Provider</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.notifications.map((n) => (
              <tr key={n.id}>
                <td>{n.type}</td>
                <td>{n.channel}</td>
                <td>
                  <StatusPill status={n.status} />
                </td>
                <td>{n.provider ?? '—'}</td>
                <td>
                  {mayMutate ? (
                    <button className="adm-btn" onClick={() => onAction({ kind: 'resend', id: n.id })}>
                      Resend
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Audit">
        <SimpleTable
          rows={d.audit.map((a) => [when(Date.parse(a.createdAt)), a.action, a.reason ?? '—'])}
          head={['When', 'Action', 'Reason']}
        />
      </Panel>
    </div>
  );
}

function SimpleTable({ rows, head }: { rows: Array<Array<React.ReactNode>>; head: string[] }): JSX.Element {
  if (rows.length === 0) return <p className="adm-muted">Nothing yet.</p>;
  return (
    <table className="adm-table">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
