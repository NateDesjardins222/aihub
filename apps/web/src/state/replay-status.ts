/**
 * Whether the platform is currently routed through a replay, and whether that
 * replay is moving.
 *
 * Written by whichever panel is polling the replay, read by anything that needs
 * to explain itself - the chart says "REPLAY PAUSED" rather than leaving a
 * trader wondering why their order has not filled. It is display state: the
 * engine is told nothing by it.
 */
import { create } from 'zustand';

interface ReplayStatusState {
  isReplay: boolean;
  replayPaused: boolean;
  blind: boolean;
  set: (patch: Partial<Omit<ReplayStatusState, 'set'>>) => void;
}

export const useReplayStatus = create<ReplayStatusState>((set) => ({
  isReplay: false,
  replayPaused: false,
  blind: false,
  set: (patch) => set(patch),
}));
