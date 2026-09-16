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

export function buildMarketDataStack(db: Database): MarketDataStack {
  const replay = new ReplayProvider();
  const provider = env().MARKET_DATA_PROVIDER === 'replay' ? replay : createLiveProvider();

  const market = new MarketDataService(provider, db, {
    staleToleranceMs: env().MARKET_DATA_STALE_MS,
    historyWarmupBars: 3_000,
    baseTimeframe: '1m',
  });

  const recorder = new SessionRecorder(resolve(env().REPLAY_DIR));

  return { market, recorder, replay, liveProviderFactory: createLiveProvider };
}
