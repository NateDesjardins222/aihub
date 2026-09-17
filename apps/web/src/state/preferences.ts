/**
 * Display preferences that survive a reload.
 *
 * Chart motion, the training mode and what it hides. All of it is presentation:
 * none of it can reach the execution engine, and the server stores it as an
 * opaque blob for exactly that reason.
 *
 * Writes are debounced, because a slider produces a preference change per
 * frame and none of them is worth a request.
 */
import { preferencesApi } from '../trading/journal-api';
import { useMotion } from './motion-store';
import { normalizeMotion, type MotionSettings } from '../chart/motion';
import { FULL_VISIBILITY, useTraining, type TrainingModeId, type Visibility } from './training';

interface StoredPreferences {
  motion?: Partial<MotionSettings>;
  training?: { modeId?: TrainingModeId; visibility?: Partial<Visibility> };
}

const WRITE_DEBOUNCE_MS = 600;
let timer: number | null = null;
let restored = false;

function write(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    const preferences: StoredPreferences = {
      motion: useMotion.getState().settings,
      training: {
        modeId: useTraining.getState().modeId,
        visibility: useTraining.getState().visibility,
      },
    };
    void preferencesApi.write(preferences as Record<string, unknown>).catch(() => undefined);
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Load a trader's preferences and keep them saved from then on.
 *
 * Safe to call more than once: the restore happens once, and the subscriptions
 * are attached once.
 */
export async function attachPreferences(): Promise<void> {
  if (restored) return;
  restored = true;

  try {
    const { preferences } = await preferencesApi.read();
    const stored = preferences as StoredPreferences;
    if (stored.motion) useMotion.getState().set(normalizeMotion(stored.motion));
    if (stored.training?.modeId) {
      useTraining.getState().restore({
        modeId: stored.training.modeId,
        visibility: { ...FULL_VISIBILITY, ...(stored.training.visibility ?? {}) },
      });
    }
  } catch {
    // A trader with no stored preferences is not an error; they get the
    // defaults, and the first change they make saves them.
  }

  useMotion.subscribe(write);
  useTraining.subscribe(write);
}
