/**
 * Copy-trading state store.
 *
 * A thin replica of the server's copy groups, the eligible accounts a group can
 * be built from, and the derived sync view. The server is authoritative for
 * every decision: this store only holds what was read back and re-reads after a
 * mutation. It never sizes a follower, decides divergence or places an order of
 * its own — those all live behind copyApi/the execution engine.
 */
import { create } from 'zustand';
import {
  copyApi,
  type CopyIntentResult,
  type EligibleAccount,
  type GroupSyncView,
  type GroupView,
} from './copy-api';

interface CopyState {
  loaded: boolean;
  busy: boolean;
  error: string | null;
  groups: GroupView[];
  eligible: EligibleAccount[];
  syncByGroup: Record<string, GroupSyncView>;
  intentsByGroup: Record<string, CopyIntentResult[]>;

  /** Load groups + eligible accounts. Safe to call repeatedly. */
  load: () => Promise<void>;
  /** Re-read one group (after a mutation) and merge it in. */
  refreshGroup: (id: string) => Promise<void>;
  refreshSync: (id: string) => Promise<void>;
  refreshIntents: (id: string) => Promise<void>;
  setError: (message: string | null) => void;
}

export const useCopy = create<CopyState>((set, get) => ({
  loaded: false,
  busy: false,
  error: null,
  groups: [],
  eligible: [],
  syncByGroup: {},
  intentsByGroup: {},

  async load() {
    set({ busy: true, error: null });
    try {
      const [{ groups }, { accounts }] = await Promise.all([
        copyApi.groups(),
        copyApi.eligibleAccounts(),
      ]);
      set({ groups, eligible: accounts, loaded: true });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Could not load copy groups.' });
    } finally {
      set({ busy: false });
    }
  },

  async refreshGroup(id) {
    try {
      const group = await copyApi.group(id);
      set((s) => ({ groups: mergeGroup(s.groups, group) }));
    } catch {
      // A group that has since been disabled/removed drops out on the next full load.
      await get().load();
    }
  },

  async refreshSync(id) {
    try {
      const sync = await copyApi.sync(id);
      set((s) => ({ syncByGroup: { ...s.syncByGroup, [id]: sync } }));
    } catch {
      /* sync is advisory; a failed read leaves the last view in place */
    }
  },

  async refreshIntents(id) {
    try {
      const { intents } = await copyApi.intents(id);
      set((s) => ({ intentsByGroup: { ...s.intentsByGroup, [id]: intents } }));
    } catch {
      /* advisory */
    }
  },

  setError(message) {
    set({ error: message });
  },
}));

function mergeGroup(groups: GroupView[], next: GroupView): GroupView[] {
  const idx = groups.findIndex((g) => g.id === next.id);
  if (idx === -1) return [...groups, next];
  const copy = groups.slice();
  copy[idx] = next;
  return copy;
}

/**
 * The single ACTIVE group whose leader is this account, if any.
 *
 * This is the whole basis of the order ticket's copy-awareness: an order
 * entered on a leader account fans out; an order on any other account (a
 * follower, or an account in no group) is an ordinary single-account order.
 * Only ACTIVE groups fan out — a PAUSED or DISABLED group trades nobody.
 */
export function activeLeaderGroupFor(state: CopyState, accountId: string | null): GroupView | null {
  if (!accountId) return null;
  return (
    state.groups.find((g) => g.status === 'ACTIVE' && g.leader?.accountId === accountId) ?? null
  );
}

/** Enabled, eligible followers of a group — the accounts an intent will actually reach. */
export function activeFollowerCount(group: GroupView): number {
  return group.followers.filter((f) => f.enabled && f.eligible).length;
}

/**
 * DISPLAY-ONLY mirror of the server's follower sizing, for a pre-trade preview.
 *
 * The server (copy-sizing.ts) is the authority: floor(leaderQty × milli / 1000)
 * for a multiplier, the fixed qty for FIXED, leaderQty for SAME, and a zero
 * result SKIPS the follower rather than sending a zero-lot order. This copy of
 * the rule is deliberately identical so the preview matches what will happen,
 * but it decides nothing — only what number to show beside a follower's name.
 */
export function previewFollowerQty(
  group: GroupView,
  follower: GroupView['followers'][number],
  leaderQty: number,
): number {
  if (group.sizingMode === 'SAME') return leaderQty;
  if (group.sizingMode === 'FIXED') return follower.sizingFixedQty ?? 0;
  const milli = follower.sizingMultiplierMilli ?? 1000;
  return Math.floor((leaderQty * milli) / 1000);
}
