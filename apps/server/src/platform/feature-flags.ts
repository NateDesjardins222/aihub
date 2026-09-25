/**
 * Feature flags (M10-F). Environment-scoped, audited, with optimistic-concurrency
 * conflict detection so two admins editing the same flag cannot silently clobber
 * each other. Never carries a secret.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { featureFlags } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';

/** Known flags (owner-manageable; the catalog is advisory, not a hard allowlist). */
export const KNOWN_FLAGS = [
  'RITHMIC_TEST_MARKET_DATA',
  'RITHMIC_TEST_EXECUTION',
  'DAILY_ACCOUNTS',
  'AFFILIATE_APPLICATIONS',
  'PHYSICAL_CERTIFICATES',
  'NEW_CHECKOUT',
] as const;

export async function listFlags(db: Database) {
  return db.select().from(featureFlags).orderBy(desc(featureFlags.updatedAt));
}

export async function isEnabled(db: Database, key: string, environment = 'ALL'): Promise<boolean> {
  const [row] = await db.select({ enabled: featureFlags.enabled }).from(featureFlags).where(and(eq(featureFlags.key, key), eq(featureFlags.environment, environment)));
  return row?.enabled ?? false;
}

export interface SetFlagInput {
  readonly organizationId: string | null;
  readonly key: string;
  readonly environment?: string;
  readonly enabled: boolean;
  readonly description?: string;
  readonly actor: Actor;
  /** For conflict detection: the updatedAt the editor last saw. */
  readonly expectedUpdatedAt?: string | null;
}

export async function setFlag(db: Database, input: SetFlagInput): Promise<{ key: string; environment: string; enabled: boolean; updatedAt: Date }> {
  const environment = input.environment ?? 'ALL';
  const [existing] = await db.select().from(featureFlags).where(and(eq(featureFlags.key, input.key), eq(featureFlags.environment, environment)));
  if (existing && input.expectedUpdatedAt && existing.updatedAt.toISOString() !== input.expectedUpdatedAt) {
    throw ApiError.conflict('FLAG_CONFLICT', 'This flag was changed by someone else; reload and retry.', { currentUpdatedAt: existing.updatedAt.toISOString() });
  }
  const now = new Date();
  let row;
  if (existing) {
    [row] = await db.update(featureFlags).set({ enabled: input.enabled, description: input.description ?? existing.description, updatedByUserId: input.actor.userId ?? null, updatedAt: now }).where(eq(featureFlags.id, existing.id)).returning();
  } else {
    [row] = await db.insert(featureFlags).values({ organizationId: input.organizationId, key: input.key, environment, enabled: input.enabled, description: input.description ?? null, updatedByUserId: input.actor.userId ?? null, updatedAt: now }).returning();
  }
  await recordAudit(db, {
    organizationId: input.organizationId, actor: input.actor, subjectType: 'ORGANIZATION', subjectId: null,
    action: 'config.feature_flag.changed', prevState: existing ? { key: input.key, enabled: existing.enabled } : null, newState: { key: input.key, enabled: input.enabled, environment },
    reason: `feature flag ${input.key}=${input.enabled}`,
  });
  return { key: row!.key, environment: row!.environment, enabled: row!.enabled, updatedAt: row!.updatedAt };
}
