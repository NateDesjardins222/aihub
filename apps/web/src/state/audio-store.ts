/**
 * The trader's audio preferences.
 *
 * Kept apart from the player itself so the player has no opinions about
 * storage and the store has none about sound: `trading-audio.ts` decides how a
 * sound is made, `execution-events.ts` decides when one is true, and this
 * decides whether the trader wants to hear it.
 */
import { create } from 'zustand';
import {
  DEFAULT_AUDIO,
  tradingAudio,
  type AudioSettings,
  type TradingSound,
} from '../audio/trading-audio';

interface AudioState {
  readonly settings: AudioSettings;
  set(patch: Partial<Omit<AudioSettings, 'events'>>): void;
  setEvent(sound: TradingSound, on: boolean): void;
  restore(stored: unknown): void;
  snapshot(): AudioSettings;
}

function clampVolume(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

export const useAudio = create<AudioState>((set, get) => ({
  settings: DEFAULT_AUDIO,

  set(patch) {
    const settings = { ...get().settings, ...patch };
    tradingAudio.configure(settings);
    set({ settings });
  },

  setEvent(sound, on) {
    const settings = {
      ...get().settings,
      events: { ...get().settings.events, [sound]: on },
    };
    tradingAudio.configure(settings);
    set({ settings });
  },

  restore(stored) {
    const input = (stored ?? {}) as Partial<AudioSettings>;
    const events = { ...DEFAULT_AUDIO.events };
    for (const key of Object.keys(events) as TradingSound[]) {
      const value = (input.events ?? {})[key];
      if (typeof value === 'boolean') events[key] = value;
    }
    const settings: AudioSettings = {
      enabled: input.enabled === true,
      volume: clampVolume(input.volume, DEFAULT_AUDIO.volume),
      events,
    };
    tradingAudio.configure(settings);
    set({ settings });
  },

  snapshot() {
    return get().settings;
  },
}));
