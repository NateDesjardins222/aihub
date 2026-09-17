/**
 * Training modes.
 *
 * A training mode changes what the trader can SEE and nothing else. Every
 * figure is still computed by the server, recorded in the journal and used by
 * the rule engine exactly as it would be otherwise - hiding the money while a
 * session runs must not change a single fill, and a mode that quietly traded
 * differently would teach the wrong lesson twice over.
 *
 * The masks are therefore applied at the point of RENDERING. Nothing in this
 * file is ever sent to the engine.
 */
import { create } from 'zustand';

export type TrainingModeId =
  | 'STANDARD'
  | 'BLIND'
  | 'NO_PNL'
  | 'PROCESS'
  | 'PROP_CHALLENGE'
  | 'RANDOM_SESSION'
  | 'CUSTOM';

export interface Visibility {
  /** Dollar profit and loss, anywhere it appears. */
  readonly pnl: boolean;
  /** Account balance, equity and drawdown figures. */
  readonly balance: boolean;
  /** The outcome of individual trades while the session is running. */
  readonly tradeResults: boolean;
  /** The date and clock: which session this is. */
  readonly dateTime: boolean;
  /** Rule progress: target, drawdown, daily limit. */
  readonly rules: boolean;
  /** The journal and its analytics, during the session. */
  readonly journal: boolean;
  /** Position size, entry price and order state - the execution picture. */
  readonly execution: boolean;
}

export const FULL_VISIBILITY: Visibility = {
  pnl: true,
  balance: true,
  tradeResults: true,
  dateTime: true,
  rules: true,
  journal: true,
  execution: true,
};

export interface TrainingMode {
  readonly id: TrainingModeId;
  readonly name: string;
  readonly description: string;
  readonly visibility: Visibility;
  /** Show everything again once the session ends. */
  readonly revealOnEnd: boolean;
  /** Load a random, unidentified session when the mode is entered. */
  readonly randomSession: boolean;
}

export const TRAINING_MODES: readonly TrainingMode[] = [
  {
    id: 'STANDARD',
    name: 'Standard',
    description: 'Everything visible. The platform as it normally is.',
    visibility: FULL_VISIBILITY,
    revealOnEnd: false,
    randomSession: false,
  },
  {
    id: 'BLIND',
    name: 'Blind',
    description:
      'The date and clock are hidden, so you cannot recognise the session or remember what came next. Everything else is normal.',
    visibility: { ...FULL_VISIBILITY, dateTime: false },
    revealOnEnd: true,
    randomSession: false,
  },
  {
    id: 'NO_PNL',
    name: 'No P&L',
    description:
      'Money is hidden while you trade: no dollar P&L, no balance, no trade outcomes. You are left with the chart and your plan.',
    visibility: {
      ...FULL_VISIBILITY,
      pnl: false,
      balance: false,
      tradeResults: false,
      rules: false,
    },
    revealOnEnd: true,
    randomSession: false,
  },
  {
    id: 'PROCESS',
    name: 'Process',
    description:
      'Execution stays visible - size, entries, stops, targets - and the financial result is withheld until the session ends.',
    visibility: {
      ...FULL_VISIBILITY,
      pnl: false,
      balance: false,
      tradeResults: false,
      journal: false,
    },
    revealOnEnd: true,
    randomSession: false,
  },
  {
    id: 'PROP_CHALLENGE',
    name: 'Prop challenge',
    description:
      'Everything visible, on a funded-account rule set. Pass it or breach it; the rules do the rest.',
    visibility: FULL_VISIBILITY,
    revealOnEnd: false,
    randomSession: false,
  },
  {
    id: 'RANDOM_SESSION',
    name: 'Random session',
    description:
      'An unknown historical session, chosen for you, with its date withheld until you finish it.',
    visibility: { ...FULL_VISIBILITY, dateTime: false },
    revealOnEnd: true,
    randomSession: true,
  },
  {
    id: 'CUSTOM',
    name: 'Custom',
    description: 'Choose exactly what you want to see.',
    visibility: FULL_VISIBILITY,
    revealOnEnd: false,
    randomSession: false,
  },
];

export function modeById(id: TrainingModeId): TrainingMode {
  return TRAINING_MODES.find((mode) => mode.id === id) ?? TRAINING_MODES[0]!;
}

interface TrainingState {
  modeId: TrainingModeId;
  /** The live mask. Equal to the mode's, unless the mode is CUSTOM. */
  visibility: Visibility;
  /** True once the session has ended and a revealing mode has opened up. */
  revealed: boolean;
  setMode: (id: TrainingModeId) => void;
  setVisibility: (patch: Partial<Visibility>) => void;
  reveal: () => void;
  restore: (state: { modeId: TrainingModeId; visibility: Visibility }) => void;
}

export const useTraining = create<TrainingState>((set, get) => ({
  modeId: 'STANDARD',
  visibility: FULL_VISIBILITY,
  revealed: false,

  setMode(id) {
    const mode = modeById(id);
    // Switching mode mid-session is allowed and immediate: it is a display
    // choice, and pretending otherwise would just make traders reload the page.
    set({
      modeId: id,
      visibility: id === 'CUSTOM' ? get().visibility : mode.visibility,
      revealed: false,
    });
  },

  setVisibility(patch) {
    set({ modeId: 'CUSTOM', visibility: { ...get().visibility, ...patch }, revealed: false });
  },

  reveal() {
    const mode = modeById(get().modeId);
    if (!mode.revealOnEnd) return;
    set({ visibility: FULL_VISIBILITY, revealed: true });
  },

  restore(state) {
    set({ modeId: state.modeId, visibility: state.visibility, revealed: false });
  },
}));

/** What a hidden figure looks like. Always the same width, so nothing jumps. */
export const MASK = '•••••';

/** Show a value, or the mask when this kind of information is hidden. */
export function masked<T>(visible: boolean, value: T, render: (value: T) => string): string {
  return visible ? render(value) : MASK;
}
