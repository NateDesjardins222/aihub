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

    const remembered = localStorage.getItem(SELECTED_ACCOUNT_KEY);
    const stillExists = accountsResponse.accounts.some((a) => a.id === remembered);
    const selectedAccountId = stillExists
      ? remembered
      : (accountsResponse.accounts[0]?.id ?? null);

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

export function activeInstrument(state: SessionState): ApiInstrument | null {
  return state.instruments.find((i) => i.root === state.activeSymbol) ?? null;
}
