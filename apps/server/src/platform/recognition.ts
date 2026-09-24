/**
 * Recognition subscriber — issues certificates and achievements on authoritative
 * lifecycle events (docs/certificates-achievements-v1.md §1.2, §3.2).
 *
 * A single deferred bystander subscriber. Like the prior milestone's subscribers,
 * it schedules its DB work off the publishing call stack (setTimeout(0)): the
 * publisher holds the caller's transaction and the org audit advisory lock, and
 * issuing certificates/achievements does org-audit-locked work of its own, so it
 * must run after that transaction commits. Every issue is idempotent (dedupe
 * keys), so replays and duplicate events converge; a failure here never fails the
 * originating event.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { payoutRequests } from '../db/schema.js';
import { events, type DomainEvent } from './events.js';
import { issueCertificate } from './certificates.js';
import { cumulativeTraderShareMicros, issueAchievement, PAYOUT_THRESHOLDS } from './achievements.js';

/**
 * Apply recognition for one event (issue any certificates/achievements it
 * warrants). Exported so it can be driven deterministically in tests; the
 * subscriber below calls it deferred. Idempotent.
 */
export async function applyRecognition(db: Database, event: DomainEvent): Promise<void> {
  return handle(db, event);
}

async function handle(db: Database, event: DomainEvent): Promise<void> {
  const organizationId = event.organizationId;
  const userId = event.userId;
  if (!organizationId || !userId) return;
  const payload = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.type) {
    case 'evaluation.qualified': {
      const qualId = typeof payload['qualificationId'] === 'string' ? (payload['qualificationId'] as string) : null;
      if (!qualId) return;
      await issueCertificate(db, {
        organizationId,
        userId,
        accountId: event.accountId ?? null,
        type: 'EVALUATION_PASSED',
        dedupeKey: `pass:${qualId}`,
      });
      return;
    }
    case 'account.funded': {
      const accountId = event.accountId ?? null;
      if (!accountId) return;
      await issueCertificate(db, { organizationId, userId, accountId, type: 'FUNDED_TRADER', dedupeKey: `funded:${accountId}` });
      // Becoming a funded trader — a once-per-identity achievement. The unique
      // index is (org, dedupeKey), so the key must be scoped to the trader.
      await issueAchievement(db, { organizationId, userId, type: 'FUNDED', dedupeKey: `funded:${userId}` });
      return;
    }
    case 'payout.paid': {
      const reqId = typeof payload['payoutRequestId'] === 'string' ? (payload['payoutRequestId'] as string) : null;
      if (!reqId) return;
      const [request] = await db.select().from(payoutRequests).where(eq(payoutRequests.id, reqId));
      const traderShare = request?.traderShareMicros ?? null;
      await issueCertificate(db, {
        organizationId,
        userId,
        accountId: event.accountId ?? request?.accountId ?? null,
        type: 'PAYOUT',
        dedupeKey: `payout:${reqId}`,
        amountMicros: traderShare,
      });
      // First payout, then cumulative trader-share thresholds. Keys are
      // trader-scoped (the unique index is (org, dedupeKey)).
      await issueAchievement(db, { organizationId, userId, type: 'FIRST_PAYOUT', dedupeKey: `first_payout:${userId}` });
      const cumulative = await cumulativeTraderShareMicros(db, userId);
      for (const t of PAYOUT_THRESHOLDS) {
        if (cumulative >= t.atMicros) {
          await issueAchievement(db, {
            organizationId,
            userId,
            type: t.type,
            dedupeKey: `${t.type.toLowerCase()}:${userId}`,
            meta: { cumulativeTraderShareMicros: cumulative },
          });
        }
      }
      return;
    }
    case 'account.completed': {
      const accountId = event.accountId ?? null;
      if (!accountId) return;
      const totalTraderShare = typeof payload['totalTraderShareMicros'] === 'number' ? (payload['totalTraderShareMicros'] as number) : null;
      await issueCertificate(db, {
        organizationId,
        userId,
        accountId,
        type: 'ACCOUNT_COMPLETED',
        dedupeKey: `complete:${accountId}`,
        amountMicros: totalTraderShare,
      });
      await issueAchievement(db, { organizationId, userId, type: 'ACCOUNT_COMPLETED', dedupeKey: `completed:${accountId}` });
      await issueAchievement(db, { organizationId, userId, type: 'FIVE_PAYOUT_CLUB', dedupeKey: `five_payout_club:${userId}` });
      return;
    }
    default:
      return;
  }
}

/**
 * Register the recognition subscriber. Returns an unsubscribe function. A
 * bystander: it defers its work and swallows its own errors so it never breaks
 * the originating lifecycle transaction.
 */
export function registerRecognition(db: Database): () => void {
  return events.subscribe((event) => {
    if (
      event.type !== 'evaluation.qualified' &&
      event.type !== 'account.funded' &&
      event.type !== 'payout.paid' &&
      event.type !== 'account.completed'
    ) {
      return;
    }
    setTimeout(() => {
      void handle(db, event).catch(() => undefined);
    }, 0);
  });
}
