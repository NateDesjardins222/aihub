/**
 * Account ↔ provider mapping (M4-P).
 *
 * An Atlas account maps to an execution mode + provider. The DEFAULT, and the
 * value for any account with no row, is SIMULATION — a customer can never
 * self-promote to external execution. Moving an account to EXTERNAL_PAPER or
 * EXTERNAL_LIVE is an explicit server-side administrative action and is audited.
 * Copy trading is unaffected: it addresses accounts by Atlas id and asks here.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { accounts, providerAccountMappings } from '../db/schema.js';
import type { ExecutionMode, ExecutionProviderKind, ProviderAccountMapping } from '@atlas/contracts';
import { recordAudit } from './audit.js';

/** The default mapping for an unmapped account — always SIMULATION. */
export function defaultMapping(accountId: string): ProviderAccountMapping {
  return {
    accountId,
    executionMode: 'SIMULATION',
    executionProvider: 'simulation',
    providerEnvironment: null,
    providerAccountId: null,
    status: 'ACTIVE',
    mappedAt: 0,
    updatedAt: 0,
  };
}

function toView(row: typeof providerAccountMappings.$inferSelect): ProviderAccountMapping {
  return {
    accountId: row.accountId,
    executionMode: row.executionMode as ExecutionMode,
    executionProvider: row.executionProvider as ExecutionProviderKind,
    providerEnvironment: row.providerEnvironment ?? null,
    providerAccountId: row.providerAccountId ?? null,
    status: row.status as 'ACTIVE' | 'SUSPENDED',
    mappedAt: row.mappedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** The mapping for an account, defaulting to SIMULATION when none exists. */
export async function getMapping(db: Database, accountId: string): Promise<ProviderAccountMapping> {
  const [row] = await db
    .select()
    .from(providerAccountMappings)
    .where(eq(providerAccountMappings.accountId, accountId));
  return row ? toView(row) : defaultMapping(accountId);
}

export interface SetMappingInput {
  accountId: string;
  executionMode: ExecutionMode;
  executionProvider: ExecutionProviderKind;
  providerEnvironment?: string | null;
  providerAccountId?: string | null;
  /** The admin performing the change — audited. */
  actorUserId: string;
  reason?: string | null;
}

export class MappingError extends Error {
  constructor(readonly code: 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_EXPOSED' | 'INVALID_MODE', message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

/**
 * Set (or change) an account's execution mapping. SERVER-SIDE / ADMIN ONLY.
 *
 * Guards:
 *  - the account must exist;
 *  - a mapping change while the account is EXPOSED (open position) is refused —
 *    an illegal mapping change while exposed would strand a position between
 *    venues. Change it while flat.
 * Every change is audited.
 */
export async function setMapping(db: Database, input: SetMappingInput): Promise<ProviderAccountMapping> {
  const [acct] = await db.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!acct || !acct.organizationId) throw new MappingError('ACCOUNT_NOT_FOUND', 'No such account.');
  const organizationId = acct.organizationId;

  // Exposure guard: never change routing while a position is open.
  const exposed = await hasOpenExposure(db, input.accountId);
  const prev = await getMapping(db, input.accountId);
  if (exposed && prev.executionMode !== input.executionMode) {
    throw new MappingError('ACCOUNT_EXPOSED', 'Cannot change execution mapping while the account has an open position.');
  }

  const now = new Date();
  const [existing] = await db
    .select()
    .from(providerAccountMappings)
    .where(eq(providerAccountMappings.accountId, input.accountId));

  if (existing) {
    await db
      .update(providerAccountMappings)
      .set({
        executionMode: input.executionMode,
        executionProvider: input.executionProvider,
        providerEnvironment: input.providerEnvironment ?? null,
        providerAccountId: input.providerAccountId ?? null,
        updatedAt: now,
      })
      .where(eq(providerAccountMappings.accountId, input.accountId));
  } else {
    await db.insert(providerAccountMappings).values({
      organizationId,
      accountId: input.accountId,
      executionMode: input.executionMode,
      executionProvider: input.executionProvider,
      providerEnvironment: input.providerEnvironment ?? null,
      providerAccountId: input.providerAccountId ?? null,
    });
  }

  await recordAudit(db, {
    organizationId,
    actor: { type: 'USER', userId: input.actorUserId },
    subjectType: 'ACCOUNT',
    subjectId: input.accountId,
    accountId: input.accountId,
    userId: input.actorUserId,
    action: 'provider.mapping.changed',
    prevState: { executionMode: prev.executionMode, executionProvider: prev.executionProvider },
    newState: { executionMode: input.executionMode, executionProvider: input.executionProvider },
    reason: input.reason ?? null,
  });

  return getMapping(db, input.accountId);
}

/** Whether the account currently has any open (non-zero) position. */
async function hasOpenExposure(db: Database, accountId: string): Promise<boolean> {
  const { positions } = await import('../db/schema.js');
  const { ne } = await import('drizzle-orm');
  const rows = await db
    .select({ qty: positions.qty })
    .from(positions)
    .where(and(eq(positions.accountId, accountId), ne(positions.qty, 0)));
  return rows.length > 0;
}
