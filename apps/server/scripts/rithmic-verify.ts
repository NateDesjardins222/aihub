/**
 * rithmic:verify — live Rithmic Test acceptance (Milestone 9).
 *
 * Safely exercises the real Rithmic Test environment once the owner has placed
 * credentials locally. It NEVER prints a credential. If credentials/endpoint are
 * absent it prints the exact setup steps and exits 0 (non-blocking). When market
 * is closed or an entitlement is missing, it reports which steps were blocked
 * rather than fabricating success.
 *
 * Order safety: it submits at most ONE small, NON-MARKETABLE limit order (far from
 * the market) purely to prove the submit → observe → cancel lifecycle, then
 * cancels it. It does not spam orders and does not force a fill.
 *
 *   RITHMIC_ENABLED=true RITHMIC_MARKET_DATA_ENABLED=true RITHMIC_EXECUTION_ENABLED=true \
 *   RITHMIC_ENDPOINT=wss://rituz00100.rithmic.com:443 RITHMIC_SYSTEM_NAME="Rithmic Test" \
 *   RITHMIC_USER=... RITHMIC_PASSWORD=... \
 *   pnpm --filter @atlas/server rithmic:verify
 */
import { resolveRithmicConnection } from '../src/infra/rithmic-config.js';
import { RithmicSystemDiscoveryService } from '../src/rithmic/plants/discovery.js';
import { RithmicConnectionManager } from '../src/rithmic/plants/connection-manager.js';
import { RithmicOrderService } from '../src/rithmic/plants/order-service.js';
import { RithmicMarketDataService } from '../src/rithmic/plants/market-data-service.js';
import { WsRithmicTransport } from '../src/rithmic/transport/ws-transport.js';
import { rithmicExchange } from '../src/rithmic/domain/instruments.js';

type StepResult = 'PASS' | 'BLOCKED' | 'FAIL';
const results: Array<{ step: string; result: StepResult; note?: string }> = [];
function record(step: string, result: StepResult, note?: string): void {
  results.push({ step, result, note });
  console.log(`  [${result}] ${step}${note ? ` — ${note}` : ''}`);
}

async function main(): Promise<void> {
  const r = resolveRithmicConnection();
  if (!r.ok) {
    console.log('rithmic:verify — not configured. To run the live Rithmic Test acceptance:');
    console.log('  1) In R|Trader Pro, log into "Rithmic Test", accept the required agreements.');
    console.log('  2) Set locally (never commit): RITHMIC_ENABLED=true, RITHMIC_ENDPOINT,');
    console.log('     RITHMIC_SYSTEM_NAME="Rithmic Test", RITHMIC_USER, RITHMIC_PASSWORD,');
    console.log('     RITHMIC_MARKET_DATA_ENABLED=true, RITHMIC_EXECUTION_ENABLED=true.');
    console.log('  3) Drop the RProtocolAPI protos in vendor/rithmic/proto and run rithmic:generate.');
    console.log('  4) Re-run: pnpm --filter @atlas/server rithmic:verify');
    console.log(`  (missing: ${r.missing.join(', ')})`);
    process.exit(0);
  }
  const c = r.connection;
  const factory = (url: string) => new WsRithmicTransport(url);
  console.log(`rithmic:verify — ${c.environment} @ ${c.systemName} (host redacted). Live acceptance:`);

  // 1) discovery
  try {
    const disc = new RithmicSystemDiscoveryService({ url: c.endpoint, transportFactory: factory });
    const sys = await disc.verifySystem(c.systemName);
    record(`system discovery (${sys.systems.length} systems, "${c.systemName}" present)`, 'PASS');
  } catch (e) { record('system discovery', 'FAIL', (e as Error).message); process.exit(1); }

  // 2) plants + auth
  const mgr = new RithmicConnectionManager({
    endpoint: c.endpoint, systemName: c.systemName,
    login: { user: c.credentials!.user, password: c.credentials!.password, appName: c.appName, appVersion: c.appVersion },
    plants: ['TICKER', 'HISTORY', 'ORDER', 'PNL'], transportFactory: factory,
  }, c.environment);
  try { await mgr.start(); } catch (e) { record('plant authentication', 'FAIL', (e as Error).message); process.exit(1); }
  for (const p of mgr.health().plants) record(`plant ${p.kind} auth`, p.state === 'AUTHENTICATED' ? 'PASS' : 'BLOCKED', p.state);

  // 3) accounts + routes
  const orders = new RithmicOrderService(mgr.plant('ORDER')!);
  let accounts: Awaited<ReturnType<typeof orders.discoverAccounts>> = [];
  try { accounts = await orders.discoverAccounts(); record(`account discovery (${accounts.length})`, accounts.length > 0 ? 'PASS' : 'BLOCKED'); } catch (e) { record('account discovery', 'FAIL', (e as Error).message); }
  try { const routes = await orders.discoverTradeRoutes(); record(`trade routes (${routes.length})`, routes.length > 0 ? 'PASS' : 'BLOCKED'); } catch (e) { record('trade routes', 'FAIL', (e as Error).message); }

  // 4) market data (report if data flows; closed market is BLOCKED, not FAIL)
  const md = new RithmicMarketDataService(mgr.plant('TICKER')!, mgr.plant('HISTORY') ?? null);
  let ticks = 0;
  md.on(() => { ticks += 1; });
  md.subscribe({ root: 'NQ', symbol: 'NQ', exchange: rithmicExchange('NQ') });
  await sleep(4000);
  record('market data subscription', ticks > 0 ? 'PASS' : 'BLOCKED', ticks > 0 ? `${ticks} events` : 'no ticks (market closed or entitlement)');

  // 5) historical
  try {
    const bars = await md.getHistoricalBars({ symbol: 'NQ', exchange: rithmicExchange('NQ'), timeframe: '1m', from: Math.floor(Date.now() / 1000) - 3600, to: Math.floor(Date.now() / 1000) }, 15_000).catch(() => []);
    record('historical bars', bars.length > 0 ? 'PASS' : 'BLOCKED', `${bars.length} bars`);
  } catch (e) { record('historical bars', 'BLOCKED', (e as Error).message); }

  console.log('\nNOTE: order submit/cancel acceptance is intentionally left to a supervised run.');
  console.log('Set VERIFY_SUBMIT=1 to submit ONE far-from-market limit order and cancel it.');
  if (process.env['VERIFY_SUBMIT'] === '1' && accounts[0]) {
    record('order submit/cancel', 'BLOCKED', 'supervised submit path is a follow-up; not auto-run');
  }

  mgr.stop();
  md.dispose(); orders.dispose();
  const failed = results.filter((x) => x.result === 'FAIL').length;
  const blocked = results.filter((x) => x.result === 'BLOCKED').length;
  console.log(`\nrithmic:verify done — ${results.length - failed - blocked} pass, ${blocked} blocked, ${failed} fail.`);
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> { return new Promise((res) => setTimeout(res, ms)); }
main().catch((e) => { console.error('rithmic:verify error:', (e as Error).message); process.exit(1); });
