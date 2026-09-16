import { useEffect, useState } from 'react';
import { fetchSymbolStatus, type FreshnessInfo } from './api';

/**
 * Feed freshness for a symbol.
 *
 * Polled every few seconds rather than pushed: this drives chrome that changes
 * slowly, and a React state update per tick is exactly what the architecture
 * avoids elsewhere.
 */
export function useFreshness(symbol: string | null, intervalMs = 5_000): FreshnessInfo | null {
  const [freshness, setFreshness] = useState<FreshnessInfo | null>(null);

  useEffect(() => {
    if (!symbol) {
      setFreshness(null);
      return;
    }
    let cancelled = false;

    const poll = async (): Promise<void> => {
      try {
        const status = await fetchSymbolStatus(symbol);
        if (!cancelled) setFreshness(status.freshness);
      } catch {
        /* the badge degrades to the stream's own connection state */
      }
    };

    void poll();
    const id = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbol, intervalMs]);

  return freshness;
}
