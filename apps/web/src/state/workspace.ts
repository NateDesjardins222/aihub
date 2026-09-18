/**
 * Workspace state: what the terminal is showing.
 *
 * The rule the layout is built on is that the chart is the application and
 * everything else is secondary. So this store holds which secondary surface is
 * open - at most one at a time - rather than a set of always-visible panels
 * competing with the chart for space.
 *
 * All of it is presentation. Nothing here can reach the execution engine.
 */
import { create } from 'zustand';
import type { Timeframe } from '@atlas/contracts';

/**
 * Secondary surfaces. Exactly one, or none, is open.
 *
 * There is no price ladder: this feed carries no order book, and a ladder
 * drawn around a last price would be a picture of depth that does not exist.
 */
export type Surface = 'PRACTICE' | 'JOURNAL' | null;

/** Which section of the settings dialog is showing. */
export type SettingsTab =
  | 'SYMBOL'
  | 'PRICE_MOTION'
  | 'STATUS_LINE'
  | 'SCALES'
  | 'CANVAS'
  | 'TRADING'
  | 'EXECUTION'
  | 'SIMULATION'
  | 'RISK'
  | 'PRACTICE_VISIBILITY';

export const ALL_TIMEFRAMES: readonly Timeframe[] = [
  '1m',
  '2m',
  '3m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '1D',
];

export const DEFAULT_FAVOURITE_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '1D'];

interface WorkspaceState {
  surface: Surface;
  settingsTab: SettingsTab | null;
  favouriteTimeframes: readonly Timeframe[];
  /** Persisted so a trader's own set of timeframes comes back on reload. */
  setFavourites: (timeframes: readonly Timeframe[]) => void;
  toggleFavourite: (timeframe: Timeframe) => void;
  openSurface: (surface: Surface) => void;
  openSettings: (tab: SettingsTab) => void;
  closeSettings: () => void;
  restore: (patch: { favouriteTimeframes?: readonly Timeframe[] }) => void;
}

const FAVOURITES_KEY = 'atlas.timeframes.favourites';

function loadFavourites(): readonly Timeframe[] {
  try {
    const raw = window.localStorage.getItem(FAVOURITES_KEY);
    if (!raw) return DEFAULT_FAVOURITE_TIMEFRAMES;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_FAVOURITE_TIMEFRAMES;
    const valid = parsed.filter((tf): tf is Timeframe =>
      (ALL_TIMEFRAMES as readonly string[]).includes(tf as string),
    );
    return valid.length > 0 ? valid : DEFAULT_FAVOURITE_TIMEFRAMES;
  } catch {
    return DEFAULT_FAVOURITE_TIMEFRAMES;
  }
}

function saveFavourites(timeframes: readonly Timeframe[]): void {
  try {
    window.localStorage.setItem(FAVOURITES_KEY, JSON.stringify(timeframes));
  } catch {
    /* storage disabled: the choice still works, it just does not stick */
  }
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  surface: null,
  settingsTab: null,
  favouriteTimeframes: loadFavourites(),

  setFavourites(timeframes) {
    // Kept in catalogue order, so the toolbar reads left to right in ascending
    // duration however the trader picked them.
    const ordered = ALL_TIMEFRAMES.filter((tf) => timeframes.includes(tf));
    saveFavourites(ordered);
    set({ favouriteTimeframes: ordered });
  },

  toggleFavourite(timeframe) {
    const current = get().favouriteTimeframes;
    const next = current.includes(timeframe)
      ? current.filter((tf) => tf !== timeframe)
      : [...current, timeframe];
    // Never leave the toolbar empty: the last favourite cannot be removed.
    if (next.length === 0) return;
    get().setFavourites(next);
  },

  openSurface(surface) {
    set({ surface: get().surface === surface ? null : surface });
  },

  openSettings(tab) {
    set({ settingsTab: tab });
  },

  closeSettings() {
    set({ settingsTab: null });
  },

  restore(patch) {
    if (patch.favouriteTimeframes && patch.favouriteTimeframes.length > 0) {
      get().setFavourites(patch.favouriteTimeframes);
    }
  },
}));
