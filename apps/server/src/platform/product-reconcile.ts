/**
 * Product reconciliation — bring the runtime product catalog to the authoritative
 * Happy Trader model (Phase 3).
 *
 * ONE mechanism, used by both the normal seed (fresh database) and the standalone
 * reconcile script (existing development database), so both converge on exactly the
 * same state:
 *
 *   - the 10 commercial evaluation products (ACTIVE), built from @atlas/contracts;
 *   - their 10 funded destinations (INTERNAL — resolvable, never sold);
 *   - the internal practice product (INTERNAL), if present;
 *   - the 7 legacy Atlas templates (RETIRED — never deleted, history preserved).
 *
 * Safety properties:
 *   - IDEMPOTENT: a product's version is republished ONLY when its terms differ
 *     from the current latest version (content comparison), so re-running never
 *     stacks identical versions and never creates duplicate profiles.
 *   - HISTORY-PRESERVING: product versions are immutable and append-only; accounts
 *     pinned to an old version keep their terms. Legacy profiles are retired by a
 *     status flag, never deleted, so historical foreign keys stay intact.
 *   - TRANSACTIONAL: each version publish runs in its own transaction (via
 *     publishProfileVersion); status updates are single idempotent statements.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  INTERNAL_PRACTICE_KEY,
  LEGACY_RETIRED_KEYS,
  htfAllProfiles,
  htfEvalProfiles,
  htfFundedProfiles,
  type HtfProfile,
} from '@atlas/contracts';
import type { Database } from '../db/client.js';
import { accountProfileVersions, accountProfiles } from '../db/schema.js';
import { normalizeProfileConfig, publishProfileVersion } from './profiles.js';

export interface ReconcileResult {
  /** Keys whose terms were (re)published as a new version. */
  readonly published: string[];
  /** Keys already at the authoritative terms (no new version written). */
  readonly unchanged: string[];
  /** Keys set ACTIVE (the 10 commercial evaluations). */
  readonly active: string[];
  /** Keys set INTERNAL (funded destinations + practice). */
  readonly internal: string[];
  /** Legacy keys set RETIRED (only those that existed). */
  readonly retired: string[];
}

/** Deterministic, key-order-independent stringify for content comparison. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Publish a new version of a product ONLY when its terms differ from the latest. */
async function publishIfChanged(
  db: Database,
  organizationId: string,
  profile: HtfProfile,
): Promise<'published' | 'unchanged'> {
  const [existing] = await db
    .select()
    .from(accountProfiles)
    .where(and(eq(accountProfiles.organizationId, organizationId), eq(accountProfiles.key, profile.key)));

  if (existing) {
    const [latest] = await db
      .select({ config: accountProfileVersions.config })
      .from(accountProfileVersions)
      .where(eq(accountProfileVersions.profileId, existing.id))
      .orderBy(desc(accountProfileVersions.version))
      .limit(1);
    if (latest) {
      const desired = stable(normalizeProfileConfig(profile.config));
      const current = stable(normalizeProfileConfig(latest.config));
      if (desired === current) return 'unchanged';
    }
  }

  await publishProfileVersion(db, {
    organizationId,
    key: profile.key,
    name: profile.name,
    accountType: profile.accountType,
    description: `Happy Trader ${profile.commercial ? 'evaluation' : 'funded destination'}: ${profile.name}`,
    config: profile.config,
    notes: 'Phase 3 authoritative product reconciliation',
  });
  return 'published';
}

/** Set status for the given keys that exist; missing keys are skipped. */
async function setStatusFor(
  db: Database,
  organizationId: string,
  keys: readonly string[],
  status: 'ACTIVE' | 'INTERNAL' | 'RETIRED',
): Promise<string[]> {
  if (keys.length === 0) return [];
  const updated = await db
    .update(accountProfiles)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(accountProfiles.organizationId, organizationId), inArray(accountProfiles.key, [...keys])))
    .returning({ key: accountProfiles.key });
  return updated.map((r) => r.key);
}

/**
 * Reconcile the runtime product catalog to the authoritative Happy Trader model.
 * Idempotent: safe to run any number of times, on a fresh or existing database.
 */
export async function reconcileHtfProducts(
  db: Database,
  organizationId: string,
): Promise<ReconcileResult> {
  const published: string[] = [];
  const unchanged: string[] = [];

  // 1. Ensure every commercial evaluation and funded destination carries the
  //    authoritative terms (publish a new immutable version only when changed).
  for (const profile of htfAllProfiles()) {
    const outcome = await publishIfChanged(db, organizationId, profile);
    (outcome === 'published' ? published : unchanged).push(profile.key);
  }

  // 2. Statuses. Evaluations are the commercial catalog (ACTIVE); funded
  //    destinations and the practice product are resolvable-but-not-commercial
  //    (INTERNAL); legacy Atlas templates are retired from active use (RETIRED),
  //    never deleted.
  const active = await setStatusFor(db, organizationId, htfEvalProfiles().map((p) => p.key), 'ACTIVE');
  const internal = await setStatusFor(
    db,
    organizationId,
    [...htfFundedProfiles().map((p) => p.key), INTERNAL_PRACTICE_KEY],
    'INTERNAL',
  );
  const retired = await setStatusFor(db, organizationId, LEGACY_RETIRED_KEYS, 'RETIRED');

  return { published, unchanged, active, internal, retired };
}
