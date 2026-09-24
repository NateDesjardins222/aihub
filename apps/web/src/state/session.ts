/**
 * Session store: who is signed in, which account is selected, which instrument
 * is in focus. Deliberately small — market ticks never enter React state.
 */
import { create } from 'zustand';
import { api, setAccessToken, setRefreshToken, getRefreshToken } from '../api/client';
import type { ApiAccount, ApiInstrument, ApiUser, AuthResponse } from '../api/types';
import { attachPreferences } from './preferences';

export type SessionPhase = 'BOOTING' | 'SIGNED_OUT' | 'SIGNED_IN';

/**
 * A trade the trader asked to see on the chart.
 *
 * Set from the journal, consumed by the chart panel: the chart switches to the
 * instrument, scrolls to the entry and marks where the trade was opened and
 * closed. It is a VIEW instruction and carries no authority - the prices in it
 * came from the server's own record of the trade.
 */
export interface ChartFocus {
  readonly symbol: string;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly side: 'LONG' | 'SHORT';
}

interface SessionState {
  phase: SessionPhase;
  user: ApiUser | null;
  accounts: ApiAccount[];
  selectedAccountId: string | null;
  instruments: ApiInstrument[];
  activeSymbol: string;
  error: string | null;
  busy: boolean;
  /** The trade the chart is being asked to show, if any. */
  chartFocus: ChartFocus | null;

  boot: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  selectAccount: (id: string) => void;
  setActiveSymbol: (symbol: string) => void;
  refreshAccounts: () => Promise<void>;
  focusTrade: (focus: ChartFocus | null) => void;
}

const SELECTED_ACCOUNT_KEY = 'atlas.selectedAccountId';
const ACTIVE_SYMBOL_KEY = 'atlas.activeSymbol';

export const useSession = create<SessionState>((set, get) => ({
  phase: 'BOOTING',
  user: null,
  accounts: [],
  selectedAccountId: null,
  instruments: [],
  activeSymbol: localStorage.getItem(ACTIVE_SYMBOL_KEY) ?? 'NQ',
  error: null,
  busy: false,
  chartFocus: null,

  /** Restore a session from the persisted refresh token, if there is one. */
  async boot() {
    if (!getRefreshToken()) {
      set({ phase: 'SIGNED_OUT' });
      return;
    }
    try {
      const { user } = await api.get<{ user: ApiUser }>('/api/v1/auth/me');
      set({ user, phase: 'SIGNED_IN' });
      await get().refreshAccounts();
      // Display preferences, restored before the terminal draws so a trader
      // does not watch their chosen mode arrive a second late.
      await attachPreferences();
    } catch {
      setRefreshToken(null);
      setAccessToken(null);
      set({ phase: 'SIGNED_OUT' });
    }
  },

  async signIn(email, password) {
    set({ busy: true, error: null });
    try {
      const result = await api.post<AuthResponse>('/api/v1/auth/login', { email, password });
      setAccessToken(result.accessToken);
      setRefreshToken(result.refreshToken);
      void attachPreferences();
      set({ user: result.user, phase: 'SIGNED_IN' });
      await get().refreshAccounts();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Sign-in failed.' });
      throw err;
    } finally {
      set({ busy: false });
    }
  },

  async signOut() {
    const token = getRefreshToken();
    if (token) await api.post('/api/v1/auth/logout', { refreshToken: token }).catch(() => {});
    setAccessToken(null);
    setRefreshToken(null);
    set({ phase: 'SIGNED_OUT', user: null, accounts: [], selectedAccountId: null });
  },

  selectAccount(id) {
    localStorage.setItem(SELECTED_ACCOUNT_KEY, id);
    set({ selectedAccountId: id });
  },

  setActiveSymbol(symbol) {
    localStorage.setItem(ACTIVE_SYMBOL_KEY, symbol);
    set({ activeSymbol: symbol });
  },

  focusTrade(focus) {
    if (focus && focus.symbol !== get().activeSymbol) {
      localStorage.setItem(ACTIVE_SYMBOL_KEY, focus.symbol);
      set({ activeSymbol: focus.symbol });
    }
    set({ chartFocus: focus });
  },

  async refreshAccounts() {
    const [accountsResponse, instrumentsResponse] = await Promise.all([
      api.get<{ accounts: ApiAccount[] }>('/api/v1/accounts'),
      api.get<{ instruments: ApiInstrument[] }>('/api/v1/instruments'),
    ]);

    // Handoff from the portal's "Trade →": /?account=<publicId>. The account
    // list is owner-scoped, so matching a publicId against it IS the ownership
    // check — a publicId the caller does not own simply will not be found, and
    // the browser never asserts a permission the server did not grant. The param
    // is consumed once, then stripped from the URL so a later refresh or a manual
    // account switch is not overridden by a stale query string.
    const handoff = readAccountHandoff();
    const handoffAccount = handoff ? accountsResponse.accounts.find((a) => a.publicId === handoff) : undefined;

    const remembered = localStorage.getItem(SELECTED_ACCOUNT_KEY);
    const stillExists = accountsResponse.accounts.some((a) => a.id === remembered);
    // With nothing remembered, open on a PRACTICE account rather than whatever
    // happens to be first: an evaluation account has a drawdown and a daily
    // loss limit, and a trader opening the terminal to try something out should
    // not have to notice that before their first order.
    const practice = accountsResponse.accounts.find((a) => a.accountType === 'PRACTICE');
    const selectedAccountId = handoffAccount
      ? handoffAccount.id
      : stillExists
        ? remembered
        : (practice?.id ?? accountsResponse.accounts[0]?.id ?? null);

    // Persist an explicit handoff selection so it survives the reload the
    // portal link triggers, exactly as a manual selection would.
    if (handoffAccount) {
      try { localStorage.setItem(SELECTED_ACCOUNT_KEY, handoffAccount.id); } catch { /* ignore */ }
    }

    set({
      accounts: accountsResponse.accounts,
      instruments: instrumentsResponse.instruments,
      selectedAccountId,
    });
  },
}));

export function selectedAccount(state: SessionState): ApiAccount | null {
  return state.accounts.find((a) => a.id === state.selectedAccountId) ?? null;
}

/**
 * Read and consume the `?account=<publicId>` handoff the portal's "Trade →"
 * link adds. Returns the requested publicId once, then removes the param from
 * the address bar (without a navigation) so it applies to this load only. The
 * value is validated against the owner-scoped account list by the caller; here
 * we only sanitise the shape a public id can take.
 */
function readAccountHandoff(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('account');
    if (!raw) return null;
    params.delete('account');
    const qs = params.toString();
    const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(window.history.state, '', url);
    // Public ids are short alphanumeric handles (e.g. SIM-001234); reject
    // anything else rather than pass an unexpected string down the line.
    return /^[A-Za-z0-9-]{1,64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function activeInstrument(state: SessionState): ApiInstrument | null {
  return state.instruments.find((i) => i.root === state.activeSymbol) ?? null;
}
