/**
 * Rithmic metrics — deterministic tests (Milestone 9).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { RithmicMetrics } from './metrics.js';

let m: RithmicMetrics;
beforeEach(() => { m = new RithmicMetrics(); });

describe('rithmic metrics', () => {
  it('increments and reads counters', () => {
    m.inc('orders_submitted');
    m.inc('orders_submitted', 2);
    expect(m.get('orders_submitted')).toBe(3);
  });

  it('snapshot lists every counter as a number and heartbeat latency', () => {
    m.inc('fills');
    m.observeHeartbeatLatency(12);
    const s = m.snapshot();
    expect(s['fills']).toBe(1);
    expect(s['orders_submitted']).toBe(0);
    expect(s['heartbeat_latency_ms']).toBe(12);
  });

  it('snapshot contains no unbounded-cardinality keys (labels only)', () => {
    m.inc('fills');
    const keys = Object.keys(m.snapshot());
    // No order id / account id / symbol should ever appear as a key.
    expect(keys.every((k) => /^[a-z_]+$/.test(k))).toBe(true);
  });

  it('resets cleanly', () => {
    m.inc('reconnects');
    m.reset();
    expect(m.get('reconnects')).toBe(0);
  });
});
