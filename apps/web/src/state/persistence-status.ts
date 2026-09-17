/**
 * Whether the workspace is actually being saved.
 *
 * A save that fails silently is worse than one that fails loudly: a trader
 * marks up a chart, reloads, and their work is gone with no explanation. The
 * store holds the last failure PER SCOPE - the workspace and the drawings are
 * saved separately and can fail separately - so a successful write of one
 * cannot clear the other's error.
 */
import { create } from 'zustand';

export type SaveScope = 'workspace' | 'drawings';

export interface PersistenceState {
  readonly errors: Readonly<Partial<Record<SaveScope, string>>>;
  readonly savedAt: number | null;
  fail: (scope: SaveScope, message: string) => void;
  succeed: (scope: SaveScope) => void;
  dismiss: () => void;
}

export const usePersistence = create<PersistenceState>((set) => ({
  errors: {},
  savedAt: null,
  fail: (scope, message) =>
    set((state) => ({ errors: { ...state.errors, [scope]: message } })),
  succeed: (scope) =>
    set((state) => {
      if (state.errors[scope] === undefined) return { savedAt: Date.now() };
      const errors = { ...state.errors };
      delete errors[scope];
      return { errors, savedAt: Date.now() };
    }),
  dismiss: () => set({ errors: {} }),
}));

/** The message to show, if any. The first failure is the one that matters. */
export function saveError(state: PersistenceState): string | null {
  return state.errors.drawings ?? state.errors.workspace ?? null;
}
