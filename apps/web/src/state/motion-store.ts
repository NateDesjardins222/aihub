/**
 * Visual motion settings.
 *
 * Client-side only, and kept that way on purpose: nothing in this store is sent
 * to the server, because nothing about how the chart animates is allowed to
 * reach the execution engine. It persists to localStorage so a trader's choice
 * survives a reload, and it is read live by the chart, so changing it takes
 * effect on the next frame without remounting anything.
 */
import { create } from 'zustand';
import { DEFAULT_MOTION, normalizeMotion, type MotionSettings } from '../chart/motion';

const STORAGE_KEY = 'atlas.motion';

function load(): MotionSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeMotion(raw ? (JSON.parse(raw) as Partial<MotionSettings>) : null);
  } catch {
    return DEFAULT_MOTION;
  }
}

function save(settings: MotionSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* a browser with storage disabled still gets working settings, just not sticky ones */
  }
}

interface MotionState {
  settings: MotionSettings;
  /** The preset this came from, for the UI. Null once hand-edited. */
  presetId: string | null;
  set: (patch: Partial<MotionSettings>, presetId?: string | null) => void;
}

export const useMotion = create<MotionState>((set, get) => ({
  settings: load(),
  presetId: null,
  set(patch, presetId = null) {
    const settings = normalizeMotion({ ...get().settings, ...patch });
    save(settings);
    set({ settings, presetId });
  },
}));
