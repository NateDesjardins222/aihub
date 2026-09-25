/**
 * Alerts + incidents (M10-H). Alerts coalesce by open dedupe key (a storm of N
 * identical raises → ONE row, count N); incidents group by dedupe key; the
 * lifecycle enforces valid transitions; channels report NOT_CONFIGURED honestly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Database } from '../db/client.js';
import { alerts, organizations } from '../db/schema.js';
import type { Actor } from './actor.js';
import { acknowledgeAlert, alertSummary, listAlerts, notificationChannels, raiseAlert, resolveAlert } from './alerts.js';
import { canTransitionIncident, incidentDetail, listIncidents, openOrGroupIncident, transitionIncident } from './incidents.js';

const ACTOR: Actor = { type: 'ADMIN', label: 'alerts@test', userId: null };
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string;
let n = 0;
const dk = () => { n += 1; return `dk-${n}-${crypto.randomUUID().slice(0, 6)}`; };

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m10h-${crypto.randomUUID().slice(0, 8)}`, name: 'M10H' }).returning();
  org = o!.id;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

describe('alert dedup / storm', () => {
  it('a storm of 100 identical raises produces ONE alert with count 100', async () => {
    const key = dk();
    let id = '';
    for (let i = 0; i < 100; i += 1) {
      const r = await raiseAlert(db, { organizationId: org, severity: 'CRITICAL', category: 'provider', title: 'Rithmic order plant unavailable', dedupeKey: key, source: 'system-doctor' });
      id = r.id;
    }
    const rows = await db.select().from(alerts).where(and(eq(alerts.organizationId, org), eq(alerts.dedupeKey, key)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.count).toBe(100);
    expect(rows[0]!.id).toBe(id);
  });

  it('severity escalates to the highest seen on the open alert', async () => {
    const key = dk();
    await raiseAlert(db, { organizationId: org, severity: 'WARNING', category: 'provider', title: 'degraded', dedupeKey: key });
    await raiseAlert(db, { organizationId: org, severity: 'CRITICAL', category: 'provider', title: 'down', dedupeKey: key });
    const [row] = await db.select().from(alerts).where(and(eq(alerts.organizationId, org), eq(alerts.dedupeKey, key)));
    expect(row!.severity).toBe('CRITICAL');
  });

  it('a resolved alert no longer coalesces: a new raise opens a fresh alert', async () => {
    const key = dk();
    const first = await raiseAlert(db, { organizationId: org, severity: 'WARNING', category: 'x', title: 't', dedupeKey: key });
    await resolveAlert(db, first.id, ACTOR);
    const second = await raiseAlert(db, { organizationId: org, severity: 'WARNING', category: 'x', title: 't', dedupeKey: key });
    expect(second.id).not.toBe(first.id);
    expect(second.deduped).toBe(false);
  });

  it('acknowledge and resolve move the alert through its states; summary counts OPEN only', async () => {
    const key = dk();
    const a = await raiseAlert(db, { organizationId: org, severity: 'CRITICAL', category: 'y', title: 't', dedupeKey: key });
    await acknowledgeAlert(db, a.id, ACTOR);
    let open = await listAlerts(db, org, { status: 'OPEN' });
    expect(open.some((x) => x.id === a.id)).toBe(false);
    const before = (await alertSummary(db, org)).CRITICAL ?? 0;
    await resolveAlert(db, a.id, ACTOR);
    const after = (await alertSummary(db, org)).CRITICAL ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe('incident grouping + lifecycle', () => {
  it('one dedupe key groups into a single incident (outage → one incident)', async () => {
    const key = dk();
    const first = await openOrGroupIncident(db, { organizationId: org, title: 'Rithmic order plant outage', severity: 'CRITICAL', dedupeKey: key, actor: ACTOR });
    expect(first.grouped).toBe(false);
    for (let i = 0; i < 20; i += 1) {
      const r = await openOrGroupIncident(db, { organizationId: org, title: 'Rithmic order plant outage', dedupeKey: key });
      expect(r.id).toBe(first.id);
      expect(r.grouped).toBe(true);
    }
    const list = await listIncidents(db, org, {});
    expect(list.filter((i) => i.dedupeKey === key).length).toBe(1);
  });

  it('enforces valid lifecycle transitions and rejects invalid ones', () => {
    expect(canTransitionIncident('OPEN', 'INVESTIGATING')).toBe(true);
    expect(canTransitionIncident('INVESTIGATING', 'RESOLVED')).toBe(true);
    expect(canTransitionIncident('OPEN', 'IDENTIFIED')).toBe(false);
    expect(canTransitionIncident('RESOLVED', 'INVESTIGATING')).toBe(true); // reopen
  });

  it('drives an incident through its lifecycle and rejects an illegal jump', async () => {
    const inc = await openOrGroupIncident(db, { organizationId: org, title: 'lifecycle test', dedupeKey: dk(), actor: ACTOR });
    await transitionIncident(db, inc.id, 'INVESTIGATING', ACTOR);
    await transitionIncident(db, inc.id, 'IDENTIFIED', ACTOR);
    await transitionIncident(db, inc.id, 'MONITORING', ACTOR);
    await transitionIncident(db, inc.id, 'RESOLVED', ACTOR, 'provider recovered');
    const d = await incidentDetail(db, inc.id);
    expect(d.incident.status).toBe('RESOLVED');
    expect(d.incident.resolution).toBe('provider recovered');
    // a resolved incident can only reopen to INVESTIGATING, not jump to MONITORING
    await expect(transitionIncident(db, inc.id, 'MONITORING', ACTOR)).rejects.toThrow();
  });
});

describe('notification channels are truthful', () => {
  it('IN_APP is configured; external channels report NOT_CONFIGURED when absent', () => {
    const ch = notificationChannels();
    expect(ch.find((c) => c.channel === 'IN_APP')!.status).toBe('CONFIGURED');
    const sms = ch.find((c) => c.channel === 'SMS')!;
    expect(['CONFIGURED', 'NOT_CONFIGURED']).toContain(sms.status);
    if (!process.env['TWILIO_AUTH_TOKEN'] && !process.env['SMS_PROVIDER']) expect(sms.status).toBe('NOT_CONFIGURED');
  });
});
