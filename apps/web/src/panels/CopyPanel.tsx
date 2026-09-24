/**
 * Copy trading — the native control.
 *
 * A trader designates ONE leader account and up to FOUR followers, and from then
 * on an order entered on the leader (in the order ticket) fans out to every
 * enabled follower. This panel is where that group is built and watched: leader,
 * followers, per-follower sizing, group status, live divergence, and the
 * safety controls (pause, resume, flatten, resync).
 *
 * It holds no trading authority. Every button here calls the server, which owns
 * ownership, risk, limits, sizing and execution; the panel re-reads what the
 * server decided. The order ticket is the fan-out entry point — this panel is
 * the group's home and its emergency stop.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { useSession } from '../state/session';
import { copyApi, type GroupView, type SizingMode } from '../trading/copy-api';
import { useCopy, activeFollowerCount } from '../trading/copy-store';
import { describeRejection } from '../trading/rejection';
import { Icon } from '../ui/Icon';
import './Copy.css';

const MAX_FOLLOWERS = 4;
const SIZING_LABEL: Record<SizingMode, string> = {
  SAME: 'Same size',
  MULTIPLIER: 'Multiplier',
  FIXED: 'Fixed qty',
};

/** A fresh idempotency key for a group action (resync/flatten). */
function actionKey(kind: string, groupId: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}`;
  return `${kind}-${groupId}-${rnd}`;
}

export function CopyPanel(): JSX.Element {
  const accounts = useSession((s) => s.accounts);
  const groups = useCopy((s) => s.groups);
  const loaded = useCopy((s) => s.loaded);
  const load = useCopy((s) => s.load);
  const error = useCopy((s) => s.error);
  const setError = useCopy((s) => s.setError);

  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Which accounts the trader owns, for names — the eligible list from the
  // server carries eligibility, but a leader that has since become ineligible
  // still needs a display name.
  const accountName = useCallback(
    (id: string) => accounts.find((a) => a.id === id)?.name ?? id.slice(0, 8),
    [accounts],
  );

  return (
    <div className="cp" data-testid="copy-panel">
      <div className="cp-head">
        <span className="cp-title">Copy trading</span>
        {groups.length > 0 && !creating ? (
          <button
            className="cp-icon-btn"
            title="New copy group"
            aria-label="New copy group"
            onClick={() => setCreating(true)}
          >
            <Icon name="plus" size={13} />
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="cp-error" role="alert">
          {error}
          <button className="cp-error-x" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}

      {!loaded ? (
        <div className="cp-muted">Loading…</div>
      ) : creating || groups.length === 0 ? (
        <CreateGroup
          onDone={() => setCreating(false)}
          onCancel={groups.length > 0 ? () => setCreating(false) : null}
        />
      ) : (
        <div className="cp-groups">
          {groups
            .filter((g) => g.status !== 'DISABLED')
            .map((g) => (
              <GroupCard key={g.id} group={g} accountName={accountName} />
            ))}
        </div>
      )}
    </div>
  );
}

/** The SELECT LEADER → SIZING → CREATE flow. Followers are added after. */
function CreateGroup(props: { onDone: () => void; onCancel: (() => void) | null }): JSX.Element {
  const eligible = useCopy((s) => s.eligible);
  const load = useCopy((s) => s.load);
  const setError = useCopy((s) => s.setError);

  const usable = eligible.filter((a) => a.eligible);
  const [name, setName] = useState('Copy group');
  const [leaderId, setLeaderId] = useState<string>(usable[0]?.id ?? '');
  const [sizingMode, setSizingMode] = useState<SizingMode>('SAME');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!leaderId) return;
    setBusy(true);
    setError(null);
    try {
      await copyApi.createGroup({ name: name.trim() || 'Copy group', leaderAccountId: leaderId, sizingMode });
      await load();
      props.onDone();
    } catch (err) {
      setError(describeRejection(err));
    } finally {
      setBusy(false);
    }
  };

  if (usable.length === 0) {
    return (
      <div className="cp-muted cp-empty">
        No eligible accounts yet. A live evaluation or funded account is needed to lead a copy group.
        {props.onCancel ? (
          <button className="cp-link" onClick={props.onCancel}>
            Back
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="cp-setup" data-testid="copy-setup">
      <div className="cp-setup-lead">Designate the leader account. Followers copy its trades.</div>
      <label className="cp-field">
        <span className="cp-label">Group name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </label>
      <label className="cp-field">
        <span className="cp-label">Leader</span>
        <select value={leaderId} onChange={(e) => setLeaderId(e.target.value)}>
          {usable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.accountType}
            </option>
          ))}
        </select>
      </label>
      <label className="cp-field">
        <span className="cp-label">Sizing</span>
        <select value={sizingMode} onChange={(e) => setSizingMode(e.target.value as SizingMode)}>
          <option value="SAME">Same size as leader</option>
          <option value="MULTIPLIER">Multiplier per follower</option>
          <option value="FIXED">Fixed quantity per follower</option>
        </select>
      </label>
      <div className="cp-setup-actions">
        <button className="cp-primary" disabled={busy || !leaderId} onClick={() => void create()}>
          Create group
        </button>
        {props.onCancel ? (
          <button className="cp-ghost" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StatusPill(props: { status: string }): JSX.Element {
  const cls =
    props.status === 'ACTIVE'
      ? 'cp-pill cp-pill-on'
      : props.status === 'PAUSED'
        ? 'cp-pill cp-pill-warn'
        : 'cp-pill';
  return <span className={cls}>{props.status}</span>;
}

function GroupCard(props: { group: GroupView; accountName: (id: string) => string }): JSX.Element {
  const { group } = props;
  const load = useCopy((s) => s.load);
  const refreshGroup = useCopy((s) => s.refreshGroup);
  const refreshSync = useCopy((s) => s.refreshSync);
  const setError = useCopy((s) => s.setError);
  const sync = useCopy((s) => s.syncByGroup[group.id]);

  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const active = activeFollowerCount(group);
  const canAdd = group.followers.length < MAX_FOLLOWERS;

  // Sync view is polled lightly while the card is mounted: divergence is derived
  // from live positions server-side, so a periodic re-read keeps the badge honest
  // without the panel ever computing it.
  useEffect(() => {
    if (group.status === 'DISABLED') return undefined;
    void refreshSync(group.id);
    const t = window.setInterval(() => void refreshSync(group.id), 5_000);
    return () => window.clearInterval(t);
  }, [group.id, group.status, refreshSync]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await refreshGroup(group.id);
        await refreshSync(group.id);
      } catch (err) {
        setError(describeRejection(err));
      } finally {
        setBusy(false);
      }
    },
    [group.id, refreshGroup, refreshSync, setError],
  );

  const diverged = sync && sync.divergedAccountIds.length > 0;

  return (
    <div className="cp-card" data-testid="copy-group">
      <div className="cp-card-head">
        <span className="cp-card-name" title={group.name}>
          {group.name}
        </span>
        <StatusPill status={group.status} />
      </div>

      <div className="cp-leader">
        <span className="cp-role">LEADER</span>
        <span className="cp-acct" title={group.leader ? props.accountName(group.leader.accountId) : ''}>
          {group.leader ? props.accountName(group.leader.accountId) : 'No leader — set one'}
        </span>
        {group.leader && !group.leader.eligible ? <span className="cp-flag">ineligible</span> : null}
      </div>

      <div className="cp-sub">
        <span>{SIZING_LABEL[group.sizingMode]}</span>
        <span className="cp-dot">·</span>
        <span>
          {active}/{group.followers.length} follower{group.followers.length === 1 ? '' : 's'} active
        </span>
        {diverged ? (
          <>
            <span className="cp-dot">·</span>
            <span className="cp-diverged" data-testid="copy-diverged">
              {sync!.divergedAccountIds.length} diverged
            </span>
          </>
        ) : null}
      </div>

      <div className="cp-followers">
        {group.followers.map((f) => {
          const d = sync?.followers.find((x) => x.accountId === f.accountId);
          return (
            <div key={f.accountId} className={`cp-follower ${f.enabled ? '' : 'cp-follower-off'}`}>
              <label className="cp-toggle" title={f.enabled ? 'Enabled' : 'Disabled'}>
                <input
                  type="checkbox"
                  checked={f.enabled}
                  disabled={busy}
                  onChange={(e) =>
                    void run(() => copyApi.updateFollower(group.id, f.accountId, { enabled: e.target.checked }))
                  }
                />
              </label>
              <span className="cp-acct cp-acct-sm" title={props.accountName(f.accountId)}>
                {props.accountName(f.accountId)}
              </span>
              <FollowerSizing group={group} accountId={f.accountId} value={f} onRun={run} busy={busy} />
              {d && !d.inSync ? (
                <span className="cp-flag cp-flag-warn" title={`Expected ${d.expectedQty}, holding ${d.actualQty}`}>
                  Δ{d.deltaQty}
                </span>
              ) : null}
              <button
                className="cp-icon-btn cp-x"
                title="Remove follower"
                aria-label="Remove follower"
                disabled={busy}
                onClick={() => void run(() => copyApi.removeFollower(group.id, f.accountId))}
              >
                ×
              </button>
            </div>
          );
        })}

        {adding ? (
          <AddFollower group={group} onRun={run} onClose={() => setAdding(false)} busy={busy} />
        ) : canAdd ? (
          <button className="cp-add" disabled={busy} onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} /> Add follower
          </button>
        ) : (
          <div className="cp-muted cp-cap">Maximum {MAX_FOLLOWERS} followers.</div>
        )}
      </div>

      <div className="cp-actions">
        {group.status === 'ACTIVE' ? (
          <button className="cp-ghost" disabled={busy} onClick={() => void run(() => copyApi.pause(group.id))}>
            Pause
          </button>
        ) : (
          <button className="cp-ghost" disabled={busy} onClick={() => void run(() => copyApi.resume(group.id))}>
            Resume
          </button>
        )}
        <button
          className="cp-ghost"
          disabled={busy || !diverged}
          title={diverged ? 'Bring followers back in line with the leader' : 'Nothing to resync'}
          onClick={() => void run(() => copyApi.resync(group.id, actionKey('resync', group.id)))}
        >
          Resync
        </button>
        <button
          className="cp-danger"
          disabled={busy}
          title="Flatten the leader and all followers now"
          onClick={() => void run(() => copyApi.flatten(group.id, actionKey('flatten', group.id), null))}
        >
          Flatten all
        </button>
      </div>

      <details className="cp-more">
        <summary>Group settings</summary>
        <GroupSettings group={group} onRun={run} busy={busy} onDisabled={load} />
      </details>
    </div>
  );
}

function FollowerSizing(props: {
  group: GroupView;
  accountId: string;
  value: { sizingMultiplierMilli: number | null; sizingFixedQty: number | null };
  onRun: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}): JSX.Element | null {
  const { group, value } = props;
  if (group.sizingMode === 'SAME') return null;

  if (group.sizingMode === 'MULTIPLIER') {
    const shown = value.sizingMultiplierMilli != null ? (value.sizingMultiplierMilli / 1000).toString() : '1';
    return (
      <span className="cp-size" title="Leader qty × this, rounded down">
        ×
        <input
          className="cp-size-in"
          type="number"
          step="0.25"
          min="0"
          defaultValue={shown}
          disabled={props.busy}
          onBlur={(e) => {
            const milli = Math.max(1, Math.round(Number(e.target.value) * 1000));
            if (milli !== value.sizingMultiplierMilli) {
              void props.onRun(() =>
                copyApi.updateFollower(group.id, props.accountId, { sizingMultiplierMilli: milli }),
              );
            }
          }}
        />
      </span>
    );
  }

  const shown = value.sizingFixedQty != null ? value.sizingFixedQty.toString() : '1';
  return (
    <span className="cp-size" title="Fixed contracts per copied order">
      =
      <input
        className="cp-size-in"
        type="number"
        step="1"
        min="1"
        defaultValue={shown}
        disabled={props.busy}
        onBlur={(e) => {
          const qty = Math.max(1, Math.floor(Number(e.target.value) || 1));
          if (qty !== value.sizingFixedQty) {
            void props.onRun(() => copyApi.updateFollower(group.id, props.accountId, { sizingFixedQty: qty }));
          }
        }}
      />
    </span>
  );
}

function AddFollower(props: {
  group: GroupView;
  onRun: (work: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  busy: boolean;
}): JSX.Element {
  const eligible = useCopy((s) => s.eligible);
  const { group } = props;

  // Only accounts that are eligible, not the leader, and not already a follower.
  const taken = new Set([group.leader?.accountId, ...group.followers.map((f) => f.accountId)]);
  const options = eligible.filter((a) => a.eligible && !taken.has(a.id));
  const [accountId, setAccountId] = useState(options[0]?.id ?? '');

  if (options.length === 0) {
    return (
      <div className="cp-muted cp-cap">
        No more eligible accounts to add.
        <button className="cp-link" onClick={props.onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="cp-addrow">
      <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={props.busy}>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button
        className="cp-primary cp-sm"
        disabled={props.busy || !accountId}
        onClick={() => {
          void props.onRun(() => copyApi.addFollower(group.id, { accountId })).then(props.onClose);
        }}
      >
        Add
      </button>
      <button className="cp-ghost cp-sm" disabled={props.busy} onClick={props.onClose}>
        Cancel
      </button>
    </div>
  );
}

function GroupSettings(props: {
  group: GroupView;
  onRun: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  onDisabled: () => Promise<void>;
}): JSX.Element {
  const { group } = props;
  const [confirmDisable, setConfirmDisable] = useState(false);
  return (
    <div className="cp-settings">
      <label className="cp-field">
        <span className="cp-label">Sizing mode</span>
        <select
          value={group.sizingMode}
          disabled={props.busy}
          onChange={(e) =>
            void props.onRun(() => copyApi.updateGroup(group.id, { sizingMode: e.target.value as SizingMode }))
          }
        >
          <option value="SAME">Same size as leader</option>
          <option value="MULTIPLIER">Multiplier per follower</option>
          <option value="FIXED">Fixed quantity per follower</option>
        </select>
      </label>
      <p className="cp-note">
        Changing the leader replaces the account whose trades are copied — the group is never promoted
        silently.
      </p>
      {confirmDisable ? (
        <div className="cp-confirm">
          <span>Disable this group? Positions are left as they are.</span>
          <div className="cp-setup-actions">
            <button
              className="cp-danger cp-sm"
              disabled={props.busy}
              onClick={() =>
                void props.onRun(() => copyApi.disable(group.id)).then(() => props.onDisabled())
              }
            >
              Disable
            </button>
            <button className="cp-ghost cp-sm" disabled={props.busy} onClick={() => setConfirmDisable(false)}>
              Keep
            </button>
          </div>
        </div>
      ) : (
        <button className="cp-danger-ghost" disabled={props.busy} onClick={() => setConfirmDisable(true)}>
          Disable group
        </button>
      )}
    </div>
  );
}
