/**
 * Execution defaults.
 *
 * What the order ticket does when it is not told otherwise: time in force, and
 * whether a fill should attach protective orders automatically. None of it is
 * in the ticket itself - a trader placing an order is choosing a side and a
 * size, not configuring a platform - so it lives here and is edited in
 * Settings.
 *
 * The bracket is OFF by default. Protection is created by dragging it off the
 * position marker, which is the gesture, and nothing protective appears because
 * a preference is set.
 */
import { create } from 'zustand';

export type BracketMode = 'OFF' | 'AUTO';

export interface ExecutionDefaults {
  readonly tif: 'DAY' | 'GTC';
  readonly bracketMode: BracketMode;
  /** Distances used by AUTO, and as the starting point for a dragged level. */
  readonly stopTicks: number;
  readonly targetTicks: number;
  /** Ask before an order that would reverse an open position. */
  readonly confirmReverse: boolean;
}

export const DEFAULT_EXECUTION: ExecutionDefaults = {
  tif: 'DAY',
  bracketMode: 'OFF',
  stopTicks: 40,
  targetTicks: 80,
  confirmReverse: true,
};

interface ExecutionState {
  defaults: ExecutionDefaults;
  set: (patch: Partial<ExecutionDefaults>) => void;
  restore: (stored: unknown) => void;
  snapshot: () => ExecutionDefaults;
}

function clampTicks(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(100_000, Math.round(number));
}

export const useExecution = create<ExecutionState>((set, get) => ({
  defaults: DEFAULT_EXECUTION,

  set(patch) {
    set({ defaults: { ...get().defaults, ...patch } });
  },

  restore(stored) {
    const input = (stored ?? {}) as Partial<ExecutionDefaults>;
    set({
      defaults: {
        tif: input.tif === 'GTC' ? 'GTC' : 'DAY',
        bracketMode: input.bracketMode === 'AUTO' ? 'AUTO' : 'OFF',
        stopTicks: clampTicks(input.stopTicks, DEFAULT_EXECUTION.stopTicks),
        targetTicks: clampTicks(input.targetTicks, DEFAULT_EXECUTION.targetTicks),
        confirmReverse: input.confirmReverse !== false,
      },
    });
  },

  snapshot() {
    return get().defaults;
  },
}));
