/**
 * Instrumentation injected before the application loads.
 *
 * Everything here measures; nothing here changes how Atlas behaves. It is
 * installed with `addInitScript`, so it is in place before React mounts and
 * before the chart library takes its first frame.
 *
 * What it records:
 *   - every React commit, through the DevTools hook React looks for at startup
 *   - every animation frame, so a gesture's frame times are the real ones
 *   - long tasks, which is where a dropped frame usually comes from
 *   - every fetch and XHR, with the time it started, so "did this gesture talk
 *     to the network" is a fact rather than an opinion
 */
export const INSTRUMENT = String.raw`
(() => {
  const state = {
    commits: 0,
    components: {},
    commitLog: [],
    frames: [],
    longTasks: [],
    requests: [],
    listeners: { added: 0, byType: {} },
    sampling: false,
    sampleStart: 0,
  };
  window.__atlas = state;

  // --- React commits -------------------------------------------------------
  // React calls onCommitFiberRoot on every commit when this hook exists. It is
  // the same mechanism the DevTools profiler uses.
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    const renderers = new Map();
    let nextId = 1;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers,
      supportsFiber: true,
      isDisabled: false,
      inject(renderer) {
        const id = nextId++;
        renderers.set(id, renderer);
        return id;
      },
      onCommitFiberRoot(_id, root) {
        state.commits += 1;
        if (!state.sampling) return;
        state.commitLog.push(performance.now());
        // Which components actually did work in this commit. A development
        // build carries actualDuration on every fiber, which is what the
        // profiler reads; anything above zero rendered.
        try {
          /*
           * Self time, not subtree time.
           *
           * actualDuration on a fiber includes everything below it, so a
           * parent that did not re-render still shows a large number when one
           * of its children did. Subtracting the children's durations gives
           * the work the component itself did, which is the only figure that
           * says who to fix.
           */
          const seen = state.components;
          const selfTime = (fiber) => {
            let childTotal = 0;
            let child = fiber.child;
            while (child) {
              childTotal += child.actualDuration || 0;
              child = child.sibling;
            }
            return (fiber.actualDuration || 0) - childTotal;
          };
          const walk = (fiber, depth) => {
            if (!fiber || depth > 80) return;
            const self = selfTime(fiber);
            if (self > 0.005) {
              const type = fiber.type;
              const name =
                typeof type === 'function'
                  ? type.displayName || type.name || 'Anonymous'
                  : typeof type === 'string'
                    ? 'host:' + type
                    : type?.displayName || null;
              if (name && !name.startsWith('host:')) {
                const entry = seen[name] || { renders: 0, ms: 0 };
                entry.renders += 1;
                entry.ms += self;
                seen[name] = entry;
              }
            }
            walk(fiber.child, depth + 1);
            walk(fiber.sibling, depth + 1);
          };
          walk(root.current, 0);
        } catch {}
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
      emit() {},
      on() {},
      off() {},
      sub() { return () => {}; },
      getFiberRoots() { return new Set(); },
    };
  }

  // --- frames --------------------------------------------------------------
  let last = performance.now();
  const tick = (now) => {
    if (state.sampling) state.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // --- long tasks ----------------------------------------------------------
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (state.sampling) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {}

  // --- network -------------------------------------------------------------
  const note = (url, method) => {
    if (!state.sampling) return;
    state.requests.push({ url: String(url), method, at: performance.now() - state.sampleStart });
  };
  const originalFetch = window.fetch;
  window.fetch = function patched(input, init) {
    note(typeof input === 'string' ? input : input?.url, init?.method ?? 'GET');
    return originalFetch.apply(this, arguments);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    note(url, method);
    return open.apply(this, arguments);
  };

  // --- listeners -----------------------------------------------------------
  // A count only: a page that adds a pointermove listener per render is a
  // different problem from one that adds it once.
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function patchedAdd(type) {
    state.listeners.added += 1;
    state.listeners.byType[type] = (state.listeners.byType[type] ?? 0) + 1;
    return add.apply(this, arguments);
  };

  state.start = () => {
    state.frames.length = 0;
    state.longTasks.length = 0;
    state.requests.length = 0;
    state.commitLog.length = 0;
    state.commits = 0;
    state.components = {};
    state.sampleStart = performance.now();
    state.sampling = true;
  };

  state.stop = () => {
    state.sampling = false;
    const frames = state.frames.slice(1);
    const sorted = [...frames].sort((a, b) => a - b);
    const at = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0;
    const total = performance.now() - state.sampleStart;
    return {
      durationMs: Math.round(total),
      frames: frames.length,
      fps: frames.length ? Math.round((frames.length / total) * 1000) : 0,
      medianFrameMs: Math.round(at(0.5) * 100) / 100,
      p95FrameMs: Math.round(at(0.95) * 100) / 100,
      worstFrameMs: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
      jankFrames: frames.filter((ms) => ms > 32).length,
      commits: state.commits,
      longTasks: state.longTasks.length,
      longTaskMs: Math.round(state.longTasks.reduce((sum, t) => sum + t.duration, 0)),
      requests: state.requests.length,
      components: Object.entries(state.components)
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 8)
        .map(([name, entry]) => name + ' x' + entry.renders + ' ' + Math.round(entry.ms) + 'ms'),
      requestUrls: state.requests.slice(0, 8).map((r) => r.method + ' ' + r.url.replace(location.origin, '')),
    };
  };
})();
`;
