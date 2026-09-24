/**
 * The commerce event ledger — authenticity, dedup, replay, and audit for every
 * inbound provider event.
 *
 * `recordCommerceEvent` verifies the signature, normalises the event, and inserts
 * a `commerce_events` row with `onConflictDoNothing` on (provider,
 * provider_event_id). A replayed webhook conflicts and is reported DUPLICATE —
 * dropped before any provisioning work, on top of the order-level guard. A bad
 * signature or malformed body is RECORDED as REJECTED (never silently dropped, so
 * reconciliation can see it) and keyed off the payload digest so a spoofed
 * webhook-id cannot poison a future legitimate event's dedup slot.
 *
 * Routing a verified PAYMENT/REFUND/DISPUTE into the fulfilment funnel lives in
 * the webhook handler (checkpoint F); this module only records and dedups.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { commerceEvents } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';
import type {
  CommerceProvider,
  NormalizedCommerceEvent,
  RawCommerceEvent,
} from './commerce-provider.js';

export type CommerceEventRow = typeof commerceEvents.$inferSelect;

export type CommerceEventOutcome =
  | { kind: 'REJECTED'; reason: string; row: CommerceEventRow }
  | { kind: 'DUPLICATE'; row: CommerceEventRow }
  | { kind: 'ACCEPTED'; row: CommerceEventRow; normalized: NormalizedCommerceEvent };

function digest(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

function rejectReasonFor(verifyReason: string): 'BAD_SIGNATURE' | 'STALE' {
  return /timestamp/i.test(verifyReason) ? 'STALE' : 'BAD_SIGNATURE';
}

/**
 * Verify, normalise, and durably record an inbound commerce event, deduping on
 * (provider, provider_event_id). The caller (webhook handler) acts on an
 * ACCEPTED outcome and then marks the row PROCESSED/IGNORED/FAILED.
 */
export async function recordCommerceEvent(
  db: Database,
  input: {
    organizationId: string;
    provider: CommerceProvider;
    raw: RawCommerceEvent;
    actor?: Actor;
  },
): Promise<CommerceEventOutcome> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const payloadDigest = digest(input.raw.rawBody);
  const verification = input.provider.verifyEvent(input.raw);

  // --- Signature failure: record REJECTED, keyed off the digest (not the
  // claimed webhook-id) so a forged id cannot pre-empt a real event. ---------
  if (!verification.ok) {
    const rejectReason = rejectReasonFor(verification.reason);
    const [row] = await db
      .insert(commerceEvents)
      .values({
        organizationId: input.organizationId,
        provider: input.provider.name,
        providerEventId: `unsigned_${payloadDigest.slice(0, 40)}`,
        kind: 'UNKNOWN',
        status: 'REJECTED',
        signatureOk: false,
        rejectReason,
        payloadDigest,
      })
      .onConflictDoNothing({
        target: [commerceEvents.provider, commerceEvents.providerEventId],
      })
      .returning();
    const finalRow = row ?? (await findEvent(db, input.provider.name, `unsigned_${payloadDigest.slice(0, 40)}`))!;
    await events.publish(db, {
      type: 'commerce.event_rejected',
      organizationId: input.organizationId,
      payload: { provider: input.provider.name, reason: rejectReason },
    });
    return { kind: 'REJECTED', reason: rejectReason, row: finalRow };
  }

  // --- Verified: normalise and dedup on the provider event id. ---------------
  const normalized = input.provider.normalizeEvent(input.raw);
  const providerEventId = normalized.providerEventId ?? `nokey_${payloadDigest.slice(0, 40)}`;

  const [row] = await db
    .insert(commerceEvents)
    .values({
      organizationId: input.organizationId,
      provider: input.provider.name,
      providerEventId,
      kind: normalized.kind,
      status: 'RECEIVED',
      signatureOk: true,
      payloadDigest,
      amountMicros: normalized.amountMicros,
      currency: normalized.currency,
      providerCustomerId: normalized.providerCustomerId,
      receiptId: normalized.receiptId,
      occurredAt: normalized.occurredAt,
    })
    .onConflictDoNothing({
      target: [commerceEvents.provider, commerceEvents.providerEventId],
    })
    .returning();

  if (!row) {
    // A row with this (provider, event id) already exists — a replay/duplicate.
    const existing = (await findEvent(db, input.provider.name, providerEventId))!;
    return { kind: 'DUPLICATE', row: existing };
  }

  await recordAudit(db, {
    organizationId: input.organizationId,
    actor,
    subjectType: 'COMMERCE',
    subjectId: row.id,
    action: 'commerce.event_received',
    newState: { provider: input.provider.name, kind: normalized.kind, providerEventId },
    reason: null,
  });
  await events.publish(db, {
    type: 'commerce.event_received',
    organizationId: input.organizationId,
    payload: { commerceEventId: row.id, kind: normalized.kind, atlasOrderId: normalized.atlasOrderId },
  });

  return { kind: 'ACCEPTED', row, normalized };
}

async function findEvent(
  db: Database,
  provider: string,
  providerEventId: string,
): Promise<CommerceEventRow | undefined> {
  const [row] = await db
    .select()
    .from(commerceEvents)
    .where(
      and(
        eq(commerceEvents.provider, provider),
        eq(commerceEvents.providerEventId, providerEventId),
      ),
    );
  return row;
}

export async function markCommerceEventProcessed(
  db: Database,
  id: string,
  opts: { atlasOrderId?: string | null } = {},
): Promise<void> {
  await db
    .update(commerceEvents)
    .set({
      status: 'PROCESSED',
      processedAt: new Date(),
      ...(opts.atlasOrderId !== undefined ? { atlasOrderId: opts.atlasOrderId } : {}),
    })
    .where(eq(commerceEvents.id, id));
}

export async function markCommerceEventIgnored(db: Database, id: string): Promise<void> {
  await db
    .update(commerceEvents)
    .set({ status: 'IGNORED', processedAt: new Date() })
    .where(eq(commerceEvents.id, id));
}

export async function markCommerceEventRejected(
  db: Database,
  id: string,
  rejectReason: string,
  opts: { atlasOrderId?: string | null } = {},
): Promise<void> {
  await db
    .update(commerceEvents)
    .set({
      status: 'REJECTED',
      rejectReason: rejectReason.slice(0, 48),
      processedAt: new Date(),
      ...(opts.atlasOrderId !== undefined ? { atlasOrderId: opts.atlasOrderId } : {}),
    })
    .where(eq(commerceEvents.id, id));
}

export async function markCommerceEventFailed(
  db: Database,
  id: string,
  lastError: string,
  opts: { atlasOrderId?: string | null } = {},
): Promise<void> {
  await db
    .update(commerceEvents)
    .set({
      status: 'FAILED',
      lastError: lastError.slice(0, 200),
      processedAt: new Date(),
      ...(opts.atlasOrderId !== undefined ? { atlasOrderId: opts.atlasOrderId } : {}),
    })
    .where(eq(commerceEvents.id, id));
}
