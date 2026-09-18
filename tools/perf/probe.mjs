/**
 * The measuring instrument for this milestone.
 *
 * The existing checks report average FPS and the worst frame. The brief is
 * explicit that this is not enough: "A terminal averaging 60 FPS but freezing
 * every few seconds is NOT smooth." So this records the whole DISTRIBUTION and
 * measures input latency from three angles, because each one lies on its own:
 *
 *   frames        every rAF delta, kept, so p50/p95/p99 and the counts over
 *                 16.7/33/50ms are real percentiles rather than an average and
 *                 a maximum.
 *   interactions  the Event Timing API - the browser's own account of input
 *                 delay + handler time + presentation. Authoritative, but
 *                 Chromium rounds `duration` to 8ms for privacy, so it cannot
 *                 resolve the difference between 2ms and 7ms.
 *   response      event.timeStamp to the next animation frame, at full
 *                 precision. Resolves what Event Timing rounds away, but stops
 *                 at the frame callback rather than at the pixels.
 *
 * Neither latency number is the truth on its own. Reported together they
 * bracket it, and a disagreement between them is itself a finding.
 *
 * Installed with `page.addInitScript`, so it is running before the application
 * is, and it costs nothing until `__perf.start()` is called.
 */

/** The source injected into the page. Kept as a string: it runs in the browser. */
export const PROBE_SOURCE = `(() => {
  const state = {
    on: false,
    frames: [],
    interactions: [],
    responses: [],
    longTasks: [],
    rafId: 0,
    lastFrame: 0,
    startedAt: 0,
    label: '',
  };

  /*
   * Input to the NEXT FRAME, at full precision.
   *
   * One rAF per input event at most: scheduling a frame per pointermove during
   * a drag would be measuring the probe. \`event.timeStamp\` is when the
   * browser received the input, not when the listener ran, so this includes
   * input delay.
   */
  let pending = null;
  const onInput = (event) => {
    if (!state.on || pending !== null) return;
    const kind = event.type;
    const at = event.timeStamp;
    pending = requestAnimationFrame((frameTime) => {
      pending = null;
      state.responses.push({ kind, ms: frameTime - at });
    });
  };
  const INPUTS = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'click'];

  const frameTick = (now) => {
    if (state.lastFrame > 0) state.frames.push(now - state.lastFrame);
    state.lastFrame = now;
    state.rafId = requestAnimationFrame(frameTick);
  };

  let eventObserver = null;
  let longTaskObserver = null;

  const percentile = (sorted, p) => {
    if (sorted.length === 0) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  };

  const summarise = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      n: sorted.length,
      mean: sum / sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      worst: sorted[sorted.length - 1],
    };
  };

  window.__perf = {
    /** Begin recording. Any previous recording is discarded. */
    start(label = '') {
      this.stop();
      state.frames = [];
      state.interactions = [];
      state.responses = [];
      state.longTasks = [];
      state.label = label;
      state.lastFrame = 0;
      state.startedAt = performance.now();
      state.on = true;

      for (const type of INPUTS) {
        window.addEventListener(type, onInput, { capture: true, passive: true });
      }
      state.rafId = requestAnimationFrame(frameTick);

      try {
        eventObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.interactions.push({
              kind: entry.name,
              ms: entry.duration,
              delay: entry.processingStart - entry.startTime,
              work: entry.processingEnd - entry.processingStart,
            });
          }
        });
        // durationThreshold 0 asks for everything; the browser floors it at 16.
        eventObserver.observe({ type: 'event', buffered: false, durationThreshold: 0 });
      } catch { eventObserver = null; }

      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.longTasks.push({ ms: entry.duration, at: entry.startTime });
          }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: false });
      } catch { longTaskObserver = null; }
    },

    stop() {
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.rafId = 0;
      if (pending !== null) { cancelAnimationFrame(pending); pending = null; }
      for (const type of INPUTS) {
        window.removeEventListener(type, onInput, { capture: true });
      }
      try { eventObserver?.disconnect(); } catch {}
      try { longTaskObserver?.disconnect(); } catch {}
      eventObserver = null;
      longTaskObserver = null;
      state.on = false;
    },

    /** Everything recorded since start(), summarised. Stops recording. */
    report() {
      const elapsed = performance.now() - state.startedAt;
      this.stop();

      const frames = state.frames;
      const over = (ms) => frames.filter((f) => f > ms).length;
      const byKind = (list) => {
        const out = {};
        for (const item of list) (out[item.kind] ??= []).push(item.ms);
        for (const key of Object.keys(out)) out[key] = summarise(out[key]);
        return out;
      };

      return {
        label: state.label,
        elapsedMs: elapsed,
        /*
         * Thresholds at 20, 33 and 50ms, not 16.7.
         *
         * A 60Hz display delivers frames at 16.67ms, so "frames over 16.7ms"
         * counts floating-point noise - it reported 98 of 98 frames during a
         * perfectly smooth pan. 20ms is the first honest sign of a missed
         * frame, 33ms is one dropped, 50ms is a stutter a trader feels.
         */
        frames: {
          ...(summarise(frames) ?? { n: 0 }),
          fps: frames.length > 0 ? (frames.length / elapsed) * 1000 : 0,
          over20: over(20),
          over33: over(33),
          over50: over(50),
        },
        /** The browser's own input→paint account. Rounded to 8ms by Chromium. */
        interactions: { ...(summarise(state.interactions.map((i) => i.ms)) ?? { n: 0 }), byKind: byKind(state.interactions) },
        /** Input timestamp → next animation frame, full precision. */
        response: { ...(summarise(state.responses.map((r) => r.ms)) ?? { n: 0 }), byKind: byKind(state.responses) },
        longTasks: { ...(summarise(state.longTasks.map((t) => t.ms)) ?? { n: 0 }) },
      };
    },

    /**
     * What the page is holding on to.
     *
     * Heap is Chromium-only and needs --enable-precise-memory-info to be
     * exact; without it the figure is bucketed, which is still enough to see a
     * leak across a long session. Everything else is counted directly.
     */
    resources() {
      const canvases = document.querySelectorAll('canvas');
      let canvasPixels = 0;
      for (const c of canvases) canvasPixels += c.width * c.height;
      return {
        heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
        heapLimitMB: performance.memory ? performance.memory.jsHeapSizeLimit / 1048576 : null,
        domNodes: document.getElementsByTagName('*').length,
        canvases: canvases.length,
        canvasMPixels: canvasPixels / 1e6,
        detachedCandidates: document.querySelectorAll('[data-testid]').length,
      };
    },
  };
})();`;

/** Install the probe so it is present before the application script runs. */
export async function installProbe(page) {
  await page.addInitScript(PROBE_SOURCE);
}

/** Run `body()` with the probe recording, and return its report. */
export async function measure(page, label, body) {
  await page.evaluate((name) => window.__perf.start(name), label);
  await body();
  return page.evaluate(() => window.__perf.report());
}

/** One line of a results table. */
export function row(name, report) {
  const f = report.frames;
  const r = report.response;
  const i = report.interactions;
  const n = (v, digits = 1) => (v === null || v === undefined ? '—' : v.toFixed(digits));
  return {
    scenario: name,
    fps: n(f.fps, 0),
    frameP50: n(f.p50),
    frameP95: n(f.p95),
    frameP99: n(f.p99),
    frameWorst: n(f.worst),
    over20: f.over20,
    over33: f.over33,
    over50: f.over50,
    respP50: n(r.p50),
    respP95: n(r.p95),
    respWorst: n(r.worst),
    eventP95: n(i.p95),
    longTasks: report.longTasks.n ?? 0,
    longWorst: n(report.longTasks.worst),
  };
}

/** Print rows as a markdown table, so a report can paste them unchanged. */
export function table(rows, columns) {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const head = `| ${cols.join(' | ')} |`;
  const rule = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${cols.map((c) => r[c] ?? '—').join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}
