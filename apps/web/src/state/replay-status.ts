/**
 * Whether the terminal is ROUTED THROUGH a replay, and whether it is moving.
 *
 * Read by anything that has to explain itself - the chart says "REPLAY PAUSED"
 * rather than leaving a trader wondering why their order has not filled, and
 * the account bar says which market it is showing.
 *
 * The distinction that matters: a recording being LOADED is not the same as the
 * terminal being routed through it. A finished session leaves its recording
 * loaded while the feed goes back to live, and a badge driven by "loaded" then
 * tells the trader they are replaying while they are looking at the live
 * market. The authority is the market data mode.
 *
 * It is display state. The engine is told nothing by it.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { fetchMarketStatus } from '../market/api';

interface ReplayStatusState {
  /** True only when the active provider is the replay. */
  isReplay: boolean;
  /** True when a replay is routed AND not advancing. */
  replayPaused: boolean;
  blind: boolean;
  /**
   * How many events the recording has emitted.
   *
   * Published because a chart that has nothing to draw needs to know whether
   * the recording has anything to give it yet: a replay is moved by Restart,
   * Step, Skip and Seek as well as by Play, and a paused one sends no bars
   * over the stream to announce that it moved.
   */
  cursor: number;
  set: (patch: Partial<Omit<ReplayStatusState, 'set'>>) => void;
}

export const useReplayStatus = create<ReplayStatusState>((set) => ({
  isReplay: false,
  replayPaused: false,
  blind: false,
  cursor: 0,
  set: (patch) => set(patch),
}));

/**
 * Read the market's mode and publish it.
 *
 * Exported so a panel can refresh it immediately after an action rather than
 * waiting for the next poll - pressing Play should clear "REPLAY PAUSED" at
 * once, not a second later.
 */
export async function refreshReplayStatus(): Promise<void> {
  try {
    const status = await fetchMarketStatus();
    const routed = status.connection.mode === 'REPLAY';
    useReplayStatus.getState().set({
      isReplay: routed,
      replayPaused: routed && status.replay.loaded && !status.replay.playing,
      blind: status.replay.blind,
      cursor: status.replay.cursor,
    });
  } catch {
    // The badge simply keeps its last value; it is chrome.
  }
}

const POLL_MS = 3_000;

/** Keep the status current for as long as the caller is mounted. */
export function useReplayStatusPolling(): void {
  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void refreshReplayStatus();
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
}
