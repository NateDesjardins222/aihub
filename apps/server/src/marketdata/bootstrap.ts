/**
 * Composes the market-data stack from configuration.
 *
 * This is the one place that decides which provider implementation runs, which
 * is what keeps the vendor swappable.
 */
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import type { Database } from '../db/client.js';
import { MarketDataService } from './service.js';
import { SessionRecorder } from './recorder.js';
import { YahooDelayedProvider } from './providers/yahoo.js';
import { ReplayProvider } from './providers/replay.js';
import { DatabentoProvider } from './providers/databento.js';
import type { MarketDataProvider } from './provider.js';

export interface MarketDataStack {
  readonly market: MarketDataService;
  readonly recorder: SessionRecorder;
  readonly replay: ReplayProvider;
  readonly liveProviderFactory: () => MarketDataProvider;
}

export function createLiveProvider(): MarketDataProvider {
  return new YahooDelayedProvider({
    pollIntervalMs: env().MARKET_DATA_POLL_MS,
    declaredDelaySeconds: env().MARKET_DATA_DELAY_SECONDS,
  });
}

/**
 * Build the configured live provider. Provider choice is DELIBERATE
 * (MARKET_DATA_PROVIDER), never inferred from whether a key exists. Selecting
 * databento without a key is a fail-fast, not a silent fallback — an operator
 * who asked for the professional feed must be told the key is missing rather
 * than served the delayed dev feed under a professional label.
 */
function buildConfiguredProvider(replay: ReplayProvider): MarketDataProvider {
  const which = env().MARKET_DATA_PROVIDER;
  if (which === 'replay') return replay;
  if (which === 'databento') {
    const apiKey = env().DATABENTO_API_KEY;
    if (!apiKey) {
      throw new Error(
        'MARKET_DATA_PROVIDER=databento but DATABENTO_API_KEY is not set. ' +
          'Set the key (server-side only) or choose a different provider. ' +
          'See docs/market-data-licensing-gate.md.',
      );
    }
    return new DatabentoProvider({
      apiKey,
      dataset: env().DATABENTO_DATASET,
      declaredDelaySeconds: env().MARKET_DATA_DELAY_SECONDS,
      pollIntervalMs: env().MARKET_DATA_POLL_MS,
    });
  }
  return createLiveProvider();
}

export function buildMarketDataStack(db: Database): MarketDataStack {
  const replay = new ReplayProvider();
  const provider = buildConfiguredProvider(replay);

  const market = new MarketDataService(provider, db, {
    staleToleranceMs: env().MARKET_DATA_STALE_MS,
    historyWarmupBars: 3_000,
    baseTimeframe: '1m',
  });

  const recorder = new SessionRecorder(resolve(env().REPLAY_DIR));

  return { market, recorder, replay, liveProviderFactory: createLiveProvider };
}
