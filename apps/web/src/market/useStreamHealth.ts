/**
 * Is the market stream actually connected?
 *
 * The socket reconnects by itself, and most drops are over before a person
 * could read a warning about them - so this reports a drop only once it has
 * lasted long enough to be worth telling someone about. A terminal that
 * flashed a red word every time a laptop changed wifi cell would teach its
 * trader to ignore the word.
 *
 * Nothing is reported before the first connection of the tab: a terminal that
 * is still starting up is not a terminal that has lost its feed, and the chart
 * says its own piece while it loads.
 */
import { useEffect, useState } from 'react';
import { marketStream } from './stream';

/** How long a drop has to last before the trader is told about it. */
const GRACE_MS = 1_500;

export interface StreamHealth {
  /** Down long enough to say so. */
  readonly down: boolean;
  readonly attempts: number;
}

export function useStreamHealth(): StreamHealth {
  const [health, setHealth] = useState<StreamHealth>({ down: false, attempts: 0 });

  useEffect(() => {
    let everConnected = marketStream.getDiagnostics().connected;
    let timer: number | null = null;

    const clear = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };

    const off = marketStream.subscribeDiagnostics((diagnostics) => {
      if (diagnostics.connected) {
        everConnected = true;
        clear();
        setHealth({ down: false, attempts: 0 });
        return;
      }
      if (!everConnected) return;
      setHealth((previous) =>
        previous.attempts === diagnostics.reconnectAttempts
          ? previous
          : { down: previous.down, attempts: diagnostics.reconnectAttempts },
      );
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        setHealth({ down: true, attempts: marketStream.getDiagnostics().reconnectAttempts });
      }, GRACE_MS);
    });

    return () => {
      clear();
      off();
    };
  }, []);

  return health;
}
