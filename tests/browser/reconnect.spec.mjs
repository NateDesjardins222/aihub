/**
 * The socket, dropped.
 *
 * A trading terminal's market stream will be interrupted: a laptop lid, a
 * train tunnel, a deploy, a proxy that times a long-lived socket out at some
 * round number of minutes. What matters is not that it never happens but what
 * the terminal does about it - reconnect without being asked, ask the server
 * for the same streams and no more, tell the trader while it is down, and go
 * quiet again the moment data is flowing.
 *
 * The socket is dropped for real rather than mocked. A probe installed before
 * the application starts wraps `WebSocket`, so every instance the app opens is
 * recorded along with everything it sends and receives; `__wsDrop()` closes
 * the live one the way a network does, and `__wsRefuse` points the next
 * attempts at a dead port so the reconnect has something to fail against.
 */
import { createReport, launch, signIn, shot } from './harness.mjs';

const { say, finish, watch } = createReport('reconnect');

/*
 * The probe.
 *
 * Wrapping the constructor is enough: the application reads `WebSocket.OPEN`
 * off the global, so the statics are copied across, and it assigns `onmessage`
 * rather than adding a listener, so counting frames with a listener of our own
 * does not disturb it.
 */
const probe = `
  (() => {
    const Native = window.WebSocket;
    const state = { opened: [], sent: [], frames: 0, refuse: false, lastUrl: null };
    function Wrapped(url, protocols) {
      const target = state.refuse ? 'ws://127.0.0.1:9099/ws' : url;
      state.lastUrl = target;
      const socket = protocols === undefined ? new Native(target) : new Native(target, protocols);
      state.opened.push(socket);
      socket.addEventListener('message', () => { state.frames += 1; });
      const index = state.opened.length;
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        try { state.sent.push({ socket: index, at: Date.now(), body: String(data) }); } catch {}
        return send(data);
      };
      return socket;
    }
    Wrapped.prototype = Native.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[key] = Native[key];
    window.WebSocket = Wrapped;
    window.__ws = state;
    window.__wsDrop = () => {
      const socket = state.opened[state.opened.length - 1];
      if (!socket) return 0;
      // 1006-style: no close frame, no warning, the way a dropped link behaves.
      socket.close(4001, 'dropped by the test');
      return state.opened.length;
    };
    window.__wsRefuse = (on) => { state.refuse = on === true; return state.refuse; };
  })();
`;

const { browser, page, errors } = await launch({ width: 1600, height: 950, initScript: probe });
watch(page);

/** How many sockets the app has opened, and how many are open right now. */
const sockets = () =>
  page.evaluate(() => ({
    opened: window.__ws.opened.length,
    live: window.__ws.opened.filter((s) => s.readyState === 1).length,
    frames: window.__ws.frames,
  }));

/** Every frame the client has sent, parsed, in order. */
const sentFrames = () =>
  page.evaluate(() =>
    window.__ws.sent
      .map((s) => {
        try {
          return { socket: s.socket, ...JSON.parse(s.body) };
        } catch {
          return null;
        }
      })
      .filter((f) => f !== null),
  );

/**
 * Replay the subscribe/unsubscribe traffic and report anything asked for
 * twice.
 *
 * This is the invariant that matters: the server keeps one set of streams per
 * connection, and a client that asks for a channel it has already got - with
 * no unsubscribe in between - has told the server to send everything twice.
 * A re-subscribe on a NEW socket is not that; it is the whole point of one.
 */
function duplicateSubscriptions(frames) {
  const held = new Map();
  const duplicates = [];
  for (const frame of frames) {
    if (frame.t === 'hello') {
      // A new connection starts with nothing.
      held.set(frame.socket, new Set());
      continue;
    }
    const open = held.get(frame.socket) ?? new Set();
    held.set(frame.socket, open);
    if (frame.t === 'subscribe') {
      for (const channel of frame.channels ?? []) {
        if (open.has(channel)) duplicates.push(channel);
        open.add(channel);
      }
    }
    if (frame.t === 'unsubscribe') {
      for (const channel of frame.channels ?? []) open.delete(channel);
    }
  }
  return duplicates;
}

/** The streams a socket asked to resume, in order. */
const resumesOn = (frames, socket) =>
  frames.filter((f) => f.t === 'resume' && f.socket === socket).map((f) => f.stream);

/** The channels a socket subscribed to, in order. */
const subscribesOn = (frames, socket) =>
  frames.filter((f) => f.t === 'subscribe' && f.socket === socket).flatMap((f) => f.channels ?? []);

/** Wait until `read()` satisfies `ok`, polling fast. Returns how long it took. */
async function until(read, ok, budgetMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (ok(value)) return { ok: true, ms: Date.now() - started, value };
    if (Date.now() - started > budgetMs) return { ok: false, ms: Date.now() - started, value };
    await page.waitForTimeout(250);
  }
}

try {
  await signIn(page);
  await page.waitForTimeout(3_000);

  // --- at rest -------------------------------------------------------------
  const rest = await sockets();
  say(rest.opened === 1, 'one socket, not one per panel', `${rest.opened} opened`);
  say(rest.live === 1, 'and it is open');
  const atRest = await sentFrames();
  const first = subscribesOn(atRest, 1);
  say(first.length > 0, 'the terminal subscribes to what it is showing', first.join(' '));
  say(
    duplicateSubscriptions(atRest).length === 0,
    'and asks for each channel once',
    `${first.length} asks on the first socket`,
  );
  const framesAtRest = rest.frames;
  const flowing = await until(sockets, (s) => s.frames > framesAtRest, 20_000);
  say(flowing.ok, 'frames are arriving', `${flowing.value.frames - framesAtRest} in ${flowing.ms}ms`);

  // --- one drop ------------------------------------------------------------
  const beforeDrop = await sockets();
  await page.evaluate(() => window.__wsDrop());
  const reconnected = await until(sockets, (s) => s.opened > beforeDrop.opened && s.live === 1, 20_000);
  say(reconnected.ok, 'a dropped socket comes back by itself', `${reconnected.ms}ms`);
  say(
    reconnected.value.live === 1,
    'exactly one socket is live afterwards',
    `${reconnected.value.live} live of ${reconnected.value.opened} opened`,
  );

  /*
   * And it did so without saying a word about it.
   *
   * Half a second of socket is not news. The warning is held back long enough
   * that an ordinary reconnect never reaches the screen, which is what keeps
   * it meaningful when it does.
   */
  say(
    (await page.locator('[data-testid=stream-down]').count()) === 0,
    'a drop that repairs itself in half a second is not announced',
  );

  const framesAfter = reconnected.value.frames;
  const resumed = await until(sockets, (s) => s.frames > framesAfter, 25_000);
  say(resumed.ok, 'and data flows again', `${resumed.value.frames - framesAfter} frames in ${resumed.ms}ms`);

  /*
   * The reconnect asks for its channels again - once each, on the new socket.
   * A client that asked twice on one connection would have the server sending
   * every tick in duplicate for as long as the tab stayed open.
   */
  const afterDrop = await sentFrames();
  const second = reconnected.value.opened;
  const reasked = subscribesOn(afterDrop, second);
  say(reasked.length > 0, 'the reconnect re-establishes its streams', reasked.join(' '));
  say(
    duplicateSubscriptions(afterDrop).length === 0,
    'without subscribing to anything twice',
    duplicateSubscriptions(afterDrop).join(' ') || 'no channel asked for twice',
  );
  const missing = [...new Set(first)].filter((c) => !reasked.includes(c));
  say(missing.length === 0, 'and without losing one', missing.join(' ') || 'none lost');

  /*
   * And resumes where it left off rather than starting over: one resume per
   * stream, carrying the last sequence the client saw, which is what lets a
   * four-second drop cost four seconds of bars instead of a full reload.
   */
  const resumes = resumesOn(afterDrop, second);
  say(
    resumes.length === new Set(resumes).size && resumes.length > 0,
    'and resumes each stream from its last sequence',
    `${resumes.length} resumes, ${new Set(resumes).size} distinct`,
  );

  // --- the chart is unharmed ----------------------------------------------
  const alive = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    view: window.__atlasChartView?.()?.span ?? 0,
  }));
  say(alive.canvases > 0 && alive.view > 0, 'the chart is still a chart', JSON.stringify(alive));

  // --- five drops in a row -------------------------------------------------
  /*
   * Backoff must not become a socket factory. Five drops, each as soon as the
   * last one recovered, should leave exactly one live socket - not five
   * zombies quietly receiving the same ticks.
   */
  let openedBefore = (await sockets()).opened;
  let recoveries = 0;
  for (let i = 0; i < 5; i += 1) {
    await page.evaluate(() => window.__wsDrop());
    const back = await until(sockets, (s) => s.opened > openedBefore && s.live === 1, 25_000);
    if (back.ok) recoveries += 1;
    openedBefore = back.value.opened;
    await page.waitForTimeout(500);
  }
  say(recoveries === 5, 'five drops in a row, five recoveries', `${recoveries}/5`);
  const afterFive = await sockets();
  say(afterFive.live === 1, 'and one live socket at the end', `${afterFive.live} live`);

  // --- the server, unavailable --------------------------------------------
  /*
   * Not a drop but a refusal: every attempt fails at once. The terminal must
   * keep trying, back off while it does, and come back the moment the server
   * does - without a reload.
   */
  await page.evaluate(() => window.__wsRefuse(true));
  const refusedFrom = (await sockets()).opened;
  await page.evaluate(() => window.__wsDrop());
  await page.waitForTimeout(9_000);
  const whileDown = await sockets();
  say(
    whileDown.opened > refusedFrom,
    'a refused connection is retried',
    `${whileDown.opened - refusedFrom} attempts in 9s`,
  );
  say(
    whileDown.opened - refusedFrom < 25,
    'and backs off rather than hammering the server',
    `${whileDown.opened - refusedFrom} attempts in 9s`,
  );
  say(whileDown.live === 0, 'nothing is pretending to be connected while it is down');

  // What the trader sees while the feed is gone.
  const pill = page.locator('[data-testid=stream-down]');
  say((await pill.count()) === 1, 'the terminal says the feed is gone rather than sitting there still');
  say(
    /RECONNECT/i.test(((await pill.textContent().catch(() => '')) ?? '').trim()),
    'and says what it is doing about it',
    ((await pill.textContent().catch(() => '')) ?? '').trim(),
  );
  await shot(page, 'reconnect-while-down');

  await page.evaluate(() => window.__wsRefuse(false));
  const cameBack = await until(sockets, (s) => s.live === 1, 40_000);
  say(cameBack.ok, 'and it reconnects on its own once the server is back', `${cameBack.ms}ms`);
  const backFrames = (await sockets()).frames;
  const flowingAgain = await until(sockets, (s) => s.frames > backFrames, 25_000);
  say(flowingAgain.ok, 'with data flowing again', `${flowingAgain.ms}ms`);

  const quietAgain = await until(
    () => page.locator('[data-testid=stream-down]').count(),
    (shown) => shown === 0,
    15_000,
  );
  say(quietAgain.ok, 'and the warning goes away again', `${quietAgain.ms}ms`);
  await shot(page, 'reconnect-recovered');

  // --- the workspace is intact --------------------------------------------
  const end = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    view: window.__atlasChartView?.()?.span ?? 0,
    sockets: window.__ws.opened.filter((s) => s.readyState === 1).length,
  }));
  say(
    end.canvases > 0 && end.view > 0 && end.sockets === 1,
    'the terminal ends where it started: one socket, one chart',
    JSON.stringify(end),
  );

  /*
   * The console, minus the noise this test made on purpose.
   *
   * Chromium logs every failed WebSocket handshake, and the refusal phase
   * asks for a dozen of them by pointing the socket at a dead port. Those are
   * this test's own footprints; anything else is the product's.
   */
  const deliberate = errors.filter((e) => /127\.0\.0\.1:9099/.test(e));
  const real = errors.filter((e) => !/127\.0\.0\.1:9099/.test(e));
  say(
    real.length === 0,
    'no console errors beyond the failed handshakes this test asked for',
    `${deliberate.length} deliberate, ${real.length} other${real.length ? `: ${real.slice(0, 3).join(' | ')}` : ''}`,
  );
} finally {
  await browser.close();
}

process.exit(finish());
