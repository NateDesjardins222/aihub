/**
 * Payout destinations (Milestone 8).
 *
 * A durable, provider-tokenized destination model. We NEVER store raw bank
 * credentials — only the provider's opaque reference token and a safe masked
 * display. A destination is validated for ownership through the provider; an
 * ownership mismatch is NOT automatically fraud — it produces a review posture
 * (and, at fast-lane time, a DESTINATION exception), and may emit an M7 signal.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { payoutDestinations } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { type Actor, SYSTEM_ACTOR } from './actor.js';
import { resolvePayoutProvider } from './payout-provider-registry.js';

export type DestinationRow = typeof payoutDestinations.$inferSelect;

export class DestinationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DestinationError';
  }
}

/** Destinations the customer can actually be paid to (VERIFIED or ACTIVE). */
export function isPayable(row: DestinationRow): boolean {
  return (row.status === 'ACTIVE' || row.status === 'VERIFIED') && row.disabledAt == null && row.ownershipState !== 'OWNERSHIP_MISMATCH';
}

export async function listDestinations(db: Database, customerIdentityId: string): Promise<DestinationRow[]> {
  return db.select().from(payoutDestinations)
    .where(eq(payoutDestinations.customerIdentityId, customerIdentityId))
    .orderBy(desc(payoutDestinations.createdAt));
}

/** The destination a payout would use: the newest ACTIVE, else newest payable. */
export async function activeDestination(db: Database, customerIdentityId: string, provider: string): Promise<DestinationRow | null> {
  const rows = await db.select().from(payoutDestinations)
    .where(and(eq(payoutDestinations.customerIdentityId, customerIdentityId), eq(payoutDestinations.provider, provider)))
    .orderBy(desc(payoutDestinations.createdAt));
  return rows.find((r) => r.status === 'ACTIVE' && isPayable(r)) ?? rows.find(isPayable) ?? null;
}

export interface AddDestinationInput {
  organizationId: string;
  customerIdentityId: string;
  provider: string;
  /** Opaque provider token from the provider-hosted flow. */
  providerRef: string;
  destinationType?: string;
  /** Optional provider customer reference for ownership validation. */
  customerRef?: string;
  actor?: Actor;
}

/**
 * Register a destination captured through the provider-hosted flow, then validate
 * it with the provider. A confirmed destination becomes ACTIVE; a pending one
 * needs verification; a mismatch is recorded for review (never auto-terminated).
 */
export async function addDestination(db: Database, input: AddDestinationInput): Promise<DestinationRow> {
  const provider = resolvePayoutProvider(input.provider);
  const validation = await provider.validateDestination({ destinationRef: input.providerRef, customerRef: input.customerRef });

  const ownershipState = validation.ownership === 'CONFIRMED' ? 'OWNERSHIP_CONFIRMED'
    : validation.ownership === 'MISMATCH' ? 'OWNERSHIP_MISMATCH'
    : validation.ownership === 'PENDING' ? 'OWNERSHIP_PENDING' : 'UNVERIFIED';
  const status = validation.ownership === 'CONFIRMED' && validation.ok ? 'ACTIVE'
    : validation.ownership === 'MISMATCH' ? 'REJECTED'
    : validation.ok ? 'VERIFICATION_REQUIRED' : 'PENDING';

  const [row] = await db.insert(payoutDestinations).values({
    organizationId: input.organizationId,
    customerIdentityId: input.customerIdentityId,
    provider: input.provider,
    providerRef: input.providerRef,
    destinationType: input.destinationType ?? 'BANK_ACCOUNT',
    maskedDisplay: validation.maskedDisplay ?? null,
    ownershipState,
    status,
    capability: (validation.capability ?? null) as object | null,
    verifiedAt: status === 'ACTIVE' ? new Date() : null,
  }).returning();

  await recordAudit(db, {
    organizationId: input.organizationId, actor: input.actor ?? SYSTEM_ACTOR,
    subjectType: 'CUSTOMER', subjectId: input.customerIdentityId,
    action: 'payout_destination.added',
    newState: { destinationId: row!.id, provider: input.provider, status, ownershipState },
    reason: null,
  });
  await events.publish(db, {
    type: 'payout.destination_added', organizationId: input.organizationId,
    payload: { destinationId: row!.id, customerIdentityId: input.customerIdentityId, status },
  });
  return row!;
}

export async function getDestination(db: Database, id: string): Promise<DestinationRow | null> {
  const [row] = await db.select().from(payoutDestinations).where(eq(payoutDestinations.id, id));
  return row ?? null;
}

/** Disable a destination (customer removal or operator safety). Idempotent. */
export async function disableDestination(db: Database, id: string, actor: Actor, reason?: string): Promise<DestinationRow | null> {
  const [row] = await db.select().from(payoutDestinations).where(eq(payoutDestinations.id, id));
  if (!row) throw new DestinationError('NOT_FOUND', 'Destination not found.');
  if (row.status === 'DISABLED') return row;
  const [updated] = await db.update(payoutDestinations)
    .set({ status: 'DISABLED', disabledAt: new Date(), version: row.version + 1, updatedAt: new Date() })
    .where(eq(payoutDestinations.id, id)).returning();
  await recordAudit(db, {
    organizationId: row.organizationId, actor, subjectType: 'CUSTOMER', subjectId: row.customerIdentityId,
    action: 'payout_destination.disabled', prevState: { status: row.status }, newState: { status: 'DISABLED' }, reason: reason ?? null,
  });
  return updated ?? row;
}

/** Mark a VERIFICATION_REQUIRED destination verified + active (mock/dev flow). */
export async function markDestinationVerified(db: Database, id: string, actor: Actor): Promise<DestinationRow | null> {
  const [row] = await db.select().from(payoutDestinations).where(eq(payoutDestinations.id, id));
  if (!row) throw new DestinationError('NOT_FOUND', 'Destination not found.');
  if (row.status === 'ACTIVE') return row;
  const [updated] = await db.update(payoutDestinations)
    .set({ status: 'ACTIVE', ownershipState: 'OWNERSHIP_CONFIRMED', verifiedAt: new Date(), version: row.version + 1, updatedAt: new Date() })
    .where(eq(payoutDestinations.id, id)).returning();
  await recordAudit(db, {
    organizationId: row.organizationId, actor, subjectType: 'CUSTOMER', subjectId: row.customerIdentityId,
    action: 'payout_destination.verified', newState: { destinationId: id, status: 'ACTIVE' }, reason: null,
  });
  return updated ?? row;
}
