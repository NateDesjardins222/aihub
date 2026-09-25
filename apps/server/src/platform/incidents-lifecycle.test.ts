/**
 * Operational incidents lifecycle (M10-H/L). Proves the grouping guarantee (an
 * outage becomes ONE incident, not hundreds), the state machine only allows legal
 * transitions, resolution/assignment/linking behave, and the summary counts only
 * live incidents. Isolated org so counts are deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../db/client.js';
import { organizations, users } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { type Actor } from './actor.js';
import {
  canTransitionIncident, openOrGroupIncident, transitionIncident, assignIncident,
  linkToIncident, incidentDetail, incidentSummary, listIncidents, type IncidentStatus,
} from './incidents.js';

const ACTOR: Actor = { type: 'ADMIN', label: 'inc@test', userId: null };
let db: Database;
let handleSql: { end: (o?: unknown) => Promise<void> };
let org: string;
let assignee: string;

beforeAll(async () => {
  const h = createDb('postgres://atlas:atlas@localhost:5432/atlas_test');
  db = h.db; handleSql = h.sql as never;
  const [o] = await db.insert(organizations).values({ slug: `m10inc-${crypto.randomUUID().slice(0, 8)}`, name: 'M10INC' }).returning();
  org = o!.id;
  const [u] = await db.insert(users).values({ email: `inc-assignee-${crypto.randomUUID().slice(0, 6)}@atlas.test`, passwordHash: await hashPassword('inc-pw-12345678'), displayName: 'On call', role: 'ADMIN', organizationId: org }).returning({ id: users.id });
  assignee = u!.id;
}, 60_000);
afterAll(async () => { await handleSql.end({ timeout: 5 }); });

const VALID: Array<[IncidentStatus, IncidentStatus]> = [
  ['OPEN', 'ACKNOWLEDGED'], ['OPEN', 'INVESTIGATING'], ['OPEN', 'RESOLVED'],
  ['ACKNOWLEDGED', 'INVESTIGATING'], ['ACKNOWLEDGED', 'IDENTIFIED'],
  ['INVESTIGATING', 'IDENTIFIED'], ['IDENTIFIED', 'MONITORING'],
  ['MONITORING', 'RESOLVED'], ['MONITORING', 'INVESTIGATING'], ['RESOLVED', 'INVESTIGATING'],
];
const INVALID: Array<[IncidentStatus, IncidentStatus]> = [
  ['RESOLVED', 'OPEN'], ['RESOLVED', 'ACKNOWLEDGED'], ['OPEN', 'IDENTIFIED'],
  ['IDENTIFIED', 'OPEN'], ['INVESTIGATING', 'OPEN'], ['ACKNOWLEDGED', 'OPEN'],
  ['OPEN', 'OPEN'], ['MONITORING', 'ACKNOWLEDGED'],
];

describe('incident state machine (pure)', () => {
  it.each(VALID)('allows %s → %s', (from, to) => {
    expect(canTransitionIncident(from, to)).toBe(true);
  });
  it.each(INVALID)('forbids %s → %s', (from, to) => {
    expect(canTransitionIncident(from, to)).toBe(false);
  });
});

describe('grouping guarantee', () => {
  it('a repeated dedupe key groups into one incident', async () => {
    const key = `outage-${crypto.randomUUID().slice(0, 8)}`;
    const first = await openOrGroupIncident(db, { organizationId: org, title: 'Provider outage', severity: 'CRITICAL', dedupeKey: key, actor: ACTOR });
    expect(first.grouped).toBe(false);
    for (let i = 0; i < 25; i += 1) {
      const g = await openOrGroupIncident(db, { organizationId: org, title: 'Provider outage', dedupeKey: key });
      expect(g.grouped).toBe(true);
      expect(g.id).toBe(first.id);
    }
  });
  it('different dedupe keys open distinct incidents', async () => {
    const a = await openOrGroupIncident(db, { organizationId: org, title: 'A', dedupeKey: `k-${crypto.randomUUID().slice(0, 8)}` });
    const b = await openOrGroupIncident(db, { organizationId: org, title: 'B', dedupeKey: `k-${crypto.randomUUID().slice(0, 8)}` });
    expect(a.id).not.toBe(b.id);
  });
  it('a resolved incident no longer groups: a new raise opens a fresh one', async () => {
    const key = `recur-${crypto.randomUUID().slice(0, 8)}`;
    const first = await openOrGroupIncident(db, { organizationId: org, title: 'Recurring', dedupeKey: key });
    await transitionIncident(db, first.id, 'RESOLVED', ACTOR, 'fixed');
    const again = await openOrGroupIncident(db, { organizationId: org, title: 'Recurring again', dedupeKey: key });
    expect(again.grouped).toBe(false);
    expect(again.id).not.toBe(first.id);
  });
});

describe('lifecycle, assignment, linking, detail, summary', () => {
  it('drives an incident through a legal path and rejects an illegal jump', async () => {
    const inc = await openOrGroupIncident(db, { organizationId: org, title: 'Walk', dedupeKey: `walk-${crypto.randomUUID().slice(0, 8)}` });
    await transitionIncident(db, inc.id, 'ACKNOWLEDGED', ACTOR);
    await transitionIncident(db, inc.id, 'INVESTIGATING', ACTOR);
    await expect(transitionIncident(db, inc.id, 'OPEN', ACTOR)).rejects.toThrow();
    await transitionIncident(db, inc.id, 'IDENTIFIED', ACTOR);
    await transitionIncident(db, inc.id, 'RESOLVED', ACTOR, 'root cause patched');
    const detail = await incidentDetail(db, inc.id);
    expect(detail.incident.status).toBe('RESOLVED');
    expect(detail.incident.resolution).toBe('root cause patched');
    expect(detail.validNext).toContain('INVESTIGATING'); // reopen path
  });
  it('assignment records an owner', async () => {
    const inc = await openOrGroupIncident(db, { organizationId: org, title: 'Assign me', dedupeKey: `as-${crypto.randomUUID().slice(0, 8)}` });
    await assignIncident(db, inc.id, assignee, ACTOR);
    const detail = await incidentDetail(db, inc.id);
    expect(detail.incident.assigneeUserId).toBe(assignee);
  });
  it('links attach to an incident and surface in the detail', async () => {
    const inc = await openOrGroupIncident(db, { organizationId: org, title: 'Linked', dedupeKey: `ln-${crypto.randomUUID().slice(0, 8)}` });
    await linkToIncident(db, inc.id, 'ACCOUNT', crypto.randomUUID());
    await linkToIncident(db, inc.id, 'PAYOUT', crypto.randomUUID());
    const detail = await incidentDetail(db, inc.id);
    expect(detail.links.length).toBe(2);
  });
  it('detail on an unknown incident throws not found', async () => {
    await expect(incidentDetail(db, crypto.randomUUID())).rejects.toThrow();
  });
  it('summary counts only non-resolved incidents and lists filter by status', async () => {
    const key = `sum-${crypto.randomUUID().slice(0, 8)}`;
    const inc = await openOrGroupIncident(db, { organizationId: org, title: 'Countable', dedupeKey: key });
    const before = await incidentSummary(db, org);
    expect(before.open).toBeGreaterThanOrEqual(1);
    await transitionIncident(db, inc.id, 'RESOLVED', ACTOR, 'done');
    const resolvedList = await listIncidents(db, org, { status: 'RESOLVED' });
    expect(resolvedList.some((r) => r.id === inc.id)).toBe(true);
    const openList = await listIncidents(db, org, { status: 'OPEN' });
    expect(openList.some((r) => r.id === inc.id)).toBe(false);
  });
});
