/**
 * Session store: who is signed in, which account is selected, which instrument
 * is in focus. Deliberately small — market ticks never enter React state.
 */
import { create } from 'zustand';
import { api, setAccessToken, setRefreshToken, getRefreshToken } from '../api/client';
import type { ApiAccount, ApiInstrument, ApiUser, AuthResponse } from '../api/types';

export type SessionPhase = 'BOOTING' | 'SIGNED_OUT' | 'SIGNED_IN';

interface SessionState {
  phase: SessionPhase;
  user: ApiUser | null;
  accounts: ApiAccount[];
  selectedAccountId: string | null;
  instruments: ApiInstrument[];
  activeSymbol: string;
  error: string | null;
  busy: boolean;

  boot: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  selectAccount: (id: string) => void;
  setActiveSymbol: (symbol: string) => void;
  refreshAccounts: () => Promise<void>;
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
