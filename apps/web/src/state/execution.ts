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
  /**
   * Does break even mean the entry, or the entry plus getting out again?
   *
   * Stated rather than assumed, because both answers are defensible and a
   * platform that silently picks one is telling a trader their stop is
   * somewhere it is not.
   */
  readonly breakEvenIncludesFees: boolean;
  /**
   * Ask once before sending, instead of sending on the first press.
   *
   * OFF by default, because one-click IS the default: a trader who has chosen
   * a side and a size has made the decision, and a dialog between them and
   * the market is a platform second-guessing them. On, the button arms itself
   * for a few seconds and the second press sends - which is a catch, not a
   * dialog, and never covers the chart.
   */
  readonly confirmOrders: boolean;
}

export const DEFAULT_EXECUTION: ExecutionDefaults = {
  tif: 'DAY',
  bracketMode: 'OFF',
  stopTicks: 40,
  targetTicks: 80,
  confirmReverse: true,
  breakEvenIncludesFees: false,
  confirmOrders: false,
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
        breakEvenIncludesFees: input.breakEvenIncludesFees === true,
        confirmOrders: input.confirmOrders === true,
      },
    });
  },

  snapshot() {
    return get().defaults;
  },
}));
