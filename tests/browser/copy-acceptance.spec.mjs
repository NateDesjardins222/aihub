/**
 * Native copy trading — real-browser acceptance (CT-M).
 *
 * Drives the ACTUAL Atlas terminal against the real server, database and engine:
 * a customer designates one leader account and up to four followers, an order
 * entered on the leader fans out to every follower through the one authoritative
 * pipeline, divergence is detected and resynced, the group pauses and flattens,
 * and — the regression that matters — a non-copy account trades exactly as it
 * always did.
 *
 * Setup uses the copy REST API for determinism (the same surface the UI calls);
 * every assertion that matters is read from the rendered UI or from server
 * state, never faked.
 *
 *   node tests/browser/copy-acceptance.spec.mjs
 */
import { createReport, launch, signIn, apiFetch, shot, useAccount, stepReplay, WEB } from './harness.mjs';

const { say, finish, watch } = createReport('copy-acceptance');
const { browser, page, errors } = await launch({ width: 1680, height: 950 });
watch(page);

const get = (path) => apiFetch(page, path);
const post = (path, body) => apiFetch(page, path, { method: 'POST', body });
const del = (path) => apiFetch(page, path, { method: 'DELETE' });
const key = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function posQty(accountId, symbol = 'NQ') {
  const r = await get(`/api/v1/positions?accountId=${accountId}`);
  const p = (r.body?.positions ?? []).find((x) => x.symbol === symbol);
  return p ? p.qty : 0;
}

/**
 * Deterministic, fast fills: drive a paused recording rather than waiting on the
 * delayed live feed (which prints about once a minute). All accounts share the
 * one market provider, so a copy fan-out's children all fill from the same
 * stepping — which is exactly the point.
 */
async function setupReplay() {
  const loaded = await post('/api/v1/marketdata/replay/random', { symbol: 'NQ', blind: false });
  if (!loaded.ok) await post('/api/v1/marketdata/replay/random', { blind: false });
  await post('/api/v1/marketdata/provider', { provider: 'replay' });
  await post('/api/v1/marketdata/replay/play', {});
  await stepReplay(page, 20);
}
/**
 * Re-prime the market: over a long flow a recording can run to its end, and the
 * platform then (correctly) refuses to place a market order into a stale feed.
 * Loading a fresh recording into the already-selected replay provider refreshes
 * it without a provider switch (which open positions would block).
 */
async function refreshMarket() {
  const loaded = await post('/api/v1/marketdata/replay/random', { symbol: 'NQ', blind: false });
  if (!loaded.ok) await post('/api/v1/marketdata/replay/random', { blind: false });
  await post('/api/v1/marketdata/replay/play', {});
  // Step past the reloaded feed's non-tradeable opening era before trading.
  await stepReplay(page, 25);
}
async function nudge() {
  for (let i = 0; i < 3; i += 1) await stepReplay(page, 12);
  await page.waitForTimeout(800);
}
/** Step the recording until `pred()` holds (market orders fill on the next event). */
async function nudgeUntil(pred, tries = 10) {
  for (let i = 0; i < tries; i += 1) {
    if (await pred()) return true;
    await nudge();
  }
  return pred();
}
/**
 * Ensure a fill: alternate stepping the recording with loading a FRESH one, so a
 * market order fills whether the current recording is mid-stream, exhausted, or
 * stale. This defeats the replay-timing variability that otherwise makes a
 * real-market browser test flaky — the product is the same either way.
 */
/** True once the (replay) feed reports an OPEN, non-stale era that accepts orders. */
async function tradeable() {
  const q = await get('/api/v1/marketdata/quote?symbol=NQ');
  const era = q.body?.marketState?.state ?? null;
  const stale = q.body?.freshness?.blocksOrderEntry === true;
  return era === 'OPEN' && !stale;
}
/**
 * Make the market tradeable before a UI order: the platform correctly refuses an
 * order into a closed/stale feed, and a random recording can start in a closed
 * era. Step to advance the era; reload a fresh recording (only safe while flat)
 * if this one never opens. Returns whether it reached a tradeable state.
 */
async function primeTradeable() {
  for (let reload = 0; reload < 6; reload += 1) {
    for (let i = 0; i < 10; i += 1) {
      if (await tradeable()) return true;
      await stepReplay(page, 15);
    }
    await refreshMarket();
  }
  return tradeable();
}
async function ensureFill(pred, tries = 8) {
  if (await pred()) return true;
  for (let i = 0; i < tries; i += 1) {
    await nudge();
    if (await pred()) return true;
    await refreshMarket();
    if (await pred()) return true;
  }
  return pred();
}

try {
  await signIn(page);

  // -- clean slate FIRST: disable any groups a previous run left behind, so the
  // accounts they held count as eligible again before we choose ---------------
  const existing = await get('/api/v1/copy/groups');
  for (const g of existing.body?.groups ?? []) await post(`/api/v1/copy/groups/${g.id}/disable`, {});

  // -- pick five eligible accounts (1 leader + 4 followers) -------------------
  const elig = await get('/api/v1/copy/eligible-accounts');
  const usable = (elig.body?.accounts ?? []).filter((a) => a.eligible);
  say(usable.length >= 5, 'the trader has at least five copy-eligible accounts', `${usable.length} eligible`);
  const [leader, ...rest] = usable;
  const followers = rest.slice(0, 4);

  // -- build the group through the copy API (the UI calls the same routes) ----
  const created = await post('/api/v1/copy/groups', { name: 'Acceptance Copy', leaderAccountId: leader.id, sizingMode: 'SAME' });
  const groupId = created.body?.id;
  say(created.status === 201 && !!groupId, 'a copy group is created with an owned leader', `status ${created.status}`);
  for (const f of followers) {
    const added = await post(`/api/v1/copy/groups/${groupId}/followers`, { accountId: f.id });
    say(added.status === 201, `follower ${f.name} added`, `status ${added.status}`);
  }
  const view = await get(`/api/v1/copy/groups/${groupId}`);
  say(view.body?.followers?.length === 4, 'the group has one leader and four followers', `${view.body?.followers?.length} followers`);

  // -- the CopyPanel renders the group in the real terminal -------------------
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=copy-panel]', { timeout: 30_000 });
  await page.waitForTimeout(1_500);
  const groupCards = await page.locator('[data-testid=copy-group]').count();
  say(groupCards >= 1, 'the copy panel renders the group card', `${groupCards} card(s)`);
  const panelText = (await page.locator('[data-testid=copy-panel]').innerText().catch(() => '')) ?? '';
  say(/LEADER/i.test(panelText) && /follower/i.test(panelText), 'the panel shows the leader and followers');
  say(/ACTIVE/.test(panelText), 'the group reads ACTIVE');
  await shot(page, 'copy-panel-active');

  // -- order-entry awareness: select the leader, the ticket says COPY ACTIVE --
  await useAccount(page, leader.name);
  await page.waitForTimeout(1_200);
  const banner = page.locator('[data-testid=ticket-copy]');
  await banner.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const bannerText = (await banner.innerText().catch(() => '')) ?? '';
  say(/COPY ACTIVE/.test(bannerText), 'the order ticket shows COPY ACTIVE on the leader account', bannerText.replace(/\n/g, ' ').slice(0, 60));
  say(/leader/i.test(bannerText), 'the ticket previews the fan-out (leader + followers)');
  await shot(page, 'copy-ticket-banner');

  // -- fan-out: a BUY on the leader reaches every follower -------------------
  // setupReplay loads a FRESH recording and plays it; a freshly reloaded feed
  // starts in a non-tradeable era, so we step (never reload) around order entry.
  await setupReplay();
  const marketOpen = await primeTradeable(); // ensure an OPEN feed before ordering
  say(marketOpen, 'the (replay) market is open for order entry');
  await page.waitForTimeout(500);
  await page.click('[data-testid=buy]');
  await page.waitForTimeout(1_200); // let the copy intent POST land before stepping
  await nudgeUntil(async () => (await posQty(leader.id)) >= 1, 15);
  const leaderQ = await posQty(leader.id);
  say(leaderQ >= 1, 'the leader account has a position after the BUY', `leader qty ${leaderQ}`);
  // Followers fill on the SAME market event as the leader, so plain stepping
  // suffices — and we must not reload the recording here (a fresh recording's
  // price would mark the just-opened positions and could breach a small account).
  await nudgeUntil(async () => {
    let n = 0;
    for (const f of followers) if ((await posQty(f.id)) === leaderQ) n += 1;
    return n === 4;
  });
  let filled = 0;
  for (const f of followers) if ((await posQty(f.id)) === leaderQ && leaderQ > 0) filled += 1;
  say(filled === 4, 'all four followers copied the leader at the same size (SAME)', `${filled}/4 matched leader qty ${leaderQ}`);
  await shot(page, 'copy-fanned-out');

  // -- divergence: manually flatten ONE follower, the panel shows it ---------
  await post(`/api/v1/positions/NQ/flatten`, { accountId: followers[0].id });
  // Step only (positions are open on other accounts — do not reload the feed).
  await nudgeUntil(async () => (await posQty(followers[0].id)) === 0, 15);
  const diverged = await nudgeUntil(async () => {
    const s = await get(`/api/v1/copy/groups/${groupId}/sync`);
    return (s.body?.divergedAccountIds?.length ?? 0) >= 1;
  }, 6);
  say(diverged, 'the derived sync view reports the diverged follower');
  await page.waitForTimeout(6_000); // let the panel's 5s poll paint the badge
  const divergedBadge = await page.locator('[data-testid=copy-diverged]').count();
  say(divergedBadge >= 1, 'the panel shows a divergence indicator');
  await shot(page, 'copy-diverged');

  // -- resync closes the gap through the normal pipeline ----------------------
  const resync = await post(`/api/v1/copy/groups/${groupId}/resync`, { idempotencyKey: key('accept-resync') });
  say(resync.ok, 'resync is accepted', `status ${resync.status}`);
  const resynced = await nudgeUntil(async () => (await posQty(followers[0].id)) === leaderQ, 15);
  say(resynced, 'the resynced follower is back in line with the leader', `qty ${await posQty(followers[0].id)}`);

  // -- pause never flattens; the ticket stops fanning out --------------------
  await post(`/api/v1/copy/groups/${groupId}/pause`, {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=copy-panel]', { timeout: 30_000 });
  await useAccount(page, leader.name);
  await page.waitForTimeout(1_500);
  say((await posQty(leader.id)) >= 1, 'pausing did NOT flatten the leader position', `leader qty ${await posQty(leader.id)}`);
  const bannerWhenPaused = await page.locator('[data-testid=ticket-copy]').count();
  say(bannerWhenPaused === 0, 'the ticket no longer shows COPY ACTIVE while paused');
  await shot(page, 'copy-paused');
  await post(`/api/v1/copy/groups/${groupId}/resume`, {});

  // -- flatten all closes every member independently -------------------------
  const flat = await post(`/api/v1/copy/groups/${groupId}/flatten`, { idempotencyKey: key('accept-flat'), symbol: 'NQ' });
  say(flat.ok, 'flatten-all is accepted (200)', `status ${flat.status}`);
  const allFlat = async () => {
    for (const a of [leader, ...followers]) if ((await posQty(a.id)) !== 0) return false;
    return true;
  };
  // Try the current recording first; only if a stale feed refused the orders do
  // we reload a fresh one and re-issue (fresh key; re-flattening a flat account
  // is a no-op). A reload may mark a small account into breach, which the engine
  // flattens on breach — either way the account ends flat.
  await nudgeUntil(allFlat, 6);
  for (let attempt = 0; attempt < 5 && !(await allFlat()); attempt += 1) {
    await refreshMarket();
    await post(`/api/v1/copy/groups/${groupId}/flatten`, { idempotencyKey: key('accept-flat'), symbol: 'NQ' });
    await nudgeUntil(allFlat, 5);
  }
  let flatCount = 0;
  for (const a of [leader, ...followers]) if ((await posQty(a.id)) === 0) flatCount += 1;
  say(flatCount === 5, 'the whole group is flat after flatten-all', `${flatCount}/5 flat`);

  // -- REGRESSION: a non-copy account trades exactly as before ----------------
  const soloAccounts = (await get('/api/v1/accounts')).body?.accounts ?? [];
  const solo = soloAccounts.find((a) => a.accountType === 'PRACTICE');
  say(!!solo, 'a non-copy (practice) account exists for the regression check');
  if (solo) {
    await useAccount(page, solo.name);
    await page.waitForTimeout(1_200);
    const soloBanner = await page.locator('[data-testid=ticket-copy]').count();
    say(soloBanner === 0, 'a non-leader account shows NO copy banner (non-copy trading unchanged)');
    // Snapshot the copy accounts BEFORE the solo trade; the isolation test is
    // that the solo trade CHANGES none of them (a delta), independent of whether
    // the earlier flatten's replay fills have all landed.
    const copyBefore = {};
    for (const a of [leader, ...followers]) copyBefore[a.id] = await posQty(a.id);
    const before = await posQty(solo.id);
    await primeTradeable(); // the feed may have gone stale by now
    await page.click('[data-testid=buy]');
    await page.waitForTimeout(1_000);
    await ensureFill(async () => (await posQty(solo.id)) > before);
    const after = await posQty(solo.id);
    say(after > before, 'the non-copy account still trades normally', `qty ${before} -> ${after}`);
    // Nothing changed on any copy-group account: the solo trade is isolated.
    let leaked = 0;
    for (const a of [leader, ...followers]) if ((await posQty(a.id)) !== copyBefore[a.id]) leaked += 1;
    say(leaked === 0, 'the solo trade did not touch any copy-group account', `${leaked} changed`);
    // Clean up the solo position.
    await post(`/api/v1/positions/NQ/flatten`, { accountId: solo.id });
  }

  // Ignore the 400s that our own market-priming API calls legitimately produce
  // (reloading an already-loaded recording, flattening an already-flat account);
  // those are deliberate test scaffolding, not UI defects.
  const uiErrors = errors.filter((e) => !/400 \(Bad Request\)|Failed to load resource/.test(e));
  say(uiErrors.length === 0, 'no unexpected UI console errors during the copy flows', uiErrors.slice(0, 3).join(' | '));
} catch (err) {
  say(false, 'the acceptance run completed without throwing', String(err).slice(0, 200));
} finally {
  // Leave the workspace clean: flatten every account we touched (a lingering
  // position marks to a loss and would breach the account on a later run), then
  // disable every group.
  await get('/api/v1/accounts')
    .then((r) => Promise.all((r.body?.accounts ?? []).map((a) => post('/api/v1/positions/NQ/flatten', { accountId: a.id }).catch(() => undefined))))
    .catch(() => undefined);
  await nudge().catch(() => undefined);
  await get('/api/v1/copy/groups')
    .then((r) => Promise.all((r.body?.groups ?? []).map((g) => post(`/api/v1/copy/groups/${g.id}/disable`, {}))))
    .catch(() => undefined);
  await browser.close();
  const failed = finish();
  process.exit(failed);
}
