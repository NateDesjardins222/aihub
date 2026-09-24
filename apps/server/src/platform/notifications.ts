/**
 * Customer notifications — email & SMS, downstream of the authoritative event.
 *
 * TRADING / PAYMENT / PROVISIONING NEVER WAIT FOR A NOTIFICATION PROVIDER. A
 * committed domain event is mapped (off the publishing call stack) to at-most-one
 * notification_messages row per (logical key, channel) — unique on (org,
 * dedupe_key), so a retried event never sends the same thing twice. A separate
 * worker renders and delivers PENDING rows through the provider; a funded account
 * exists whether or not the email ever sends. See docs/notifications-v1.md.
 */
import { and, asc, eq, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { notificationMessages } from '../db/schema.js';
import { events, type DomainEvent } from './events.js';
import { getIdentityByUser } from './customer-identity.js';
import { primaryContactValue } from './contact-verification.js';
import {
  emailProviderFromEnv,
  smsProviderFromEnv,
  type EmailProvider,
  type SmsProvider,
} from './notification-providers.js';

export type NotificationChannel = 'EMAIL' | 'SMS';

export type NotificationType =
  | 'WELCOME'
  | 'VERIFY_EMAIL'
  | 'VERIFY_PHONE'
  | 'IDENTITY_STARTED'
  | 'IDENTITY_VERIFIED'
  | 'IDENTITY_ACTION_REQUIRED'
  | 'PURCHASE_CONFIRMED'
  | 'EVAL_READY'
  | 'EVAL_PASSED'
  | 'FUNDED_READY'
  | 'PAYOUT_ELIGIBLE'
  | 'PAYOUT_REQUESTED'
  | 'PAYOUT_APPROVED'
  | 'PAYOUT_PAID'
  | 'REFUND'
  | 'DISPUTE_ACTION'
  | 'SECURITY_LOGIN'
  | 'PASSWORD_CHANGED'
  | 'ACCOUNT_RESTORED'
  | 'ACCOUNT_INACTIVITY_WARNING'
  | 'ACCOUNT_INACTIVITY_CLOSED'
  | 'ACCOUNT_COMPLETED'
  // Milestone 6 — a rendered certificate/reward is ready to view in the vault.
  | 'CERTIFICATE_READY';

/** Channel policy: SMS is reserved for verification, milestones, payout, security. */
const TYPE_CHANNELS: Record<NotificationType, NotificationChannel[]> = {
  WELCOME: ['EMAIL'],
  VERIFY_EMAIL: ['EMAIL'],
  VERIFY_PHONE: ['SMS'],
  IDENTITY_STARTED: ['EMAIL'],
  IDENTITY_VERIFIED: ['EMAIL'],
  IDENTITY_ACTION_REQUIRED: ['EMAIL', 'SMS'],
  PURCHASE_CONFIRMED: ['EMAIL'],
  EVAL_READY: ['EMAIL'],
  EVAL_PASSED: ['EMAIL'],
  FUNDED_READY: ['EMAIL', 'SMS'],
  PAYOUT_ELIGIBLE: ['EMAIL'],
  PAYOUT_REQUESTED: ['EMAIL'],
  PAYOUT_APPROVED: ['EMAIL', 'SMS'],
  PAYOUT_PAID: ['EMAIL', 'SMS'],
  REFUND: ['EMAIL'],
  DISPUTE_ACTION: ['EMAIL'],
  SECURITY_LOGIN: ['EMAIL'],
  PASSWORD_CHANGED: ['EMAIL'],
  ACCOUNT_RESTORED: ['EMAIL'],
  ACCOUNT_INACTIVITY_WARNING: ['EMAIL', 'SMS'],
  ACCOUNT_INACTIVITY_CLOSED: ['EMAIL'],
  ACCOUNT_COMPLETED: ['EMAIL', 'SMS'],
  CERTIFICATE_READY: ['EMAIL'],
};

const TEMPLATE_VERSION = 'v1';

function render(type: NotificationType, data: Record<string, unknown>): { subject: string; body: string } {
  const code = typeof data['code'] === 'string' ? (data['code'] as string) : '';
  switch (type) {
    case 'WELCOME':
      return { subject: 'Welcome to Happy Trader', body: 'Your account is set up. Verify your contact details to continue.' };
    case 'VERIFY_EMAIL':
      return { subject: 'Verify your email', body: `Your verification code is ${code}.` };
    case 'VERIFY_PHONE':
      return { subject: 'Verify your phone', body: `Your verification code is ${code}.` };
    case 'IDENTITY_STARTED':
      return { subject: 'Identity verification started', body: 'We have started verifying your identity.' };
    case 'IDENTITY_VERIFIED':
      return { subject: 'Identity verified', body: 'Your identity has been verified.' };
    case 'IDENTITY_ACTION_REQUIRED':
      return { subject: 'Action needed on your verification', body: 'Please complete an additional step to verify your identity.' };
    case 'PURCHASE_CONFIRMED':
      return { subject: 'Purchase confirmed', body: 'We received your payment and are setting up your account.' };
    case 'EVAL_READY':
      return { subject: 'Your evaluation account is ready', body: 'Your evaluation account is active and ready to trade.' };
    case 'EVAL_PASSED':
      return { subject: 'You passed your evaluation', body: 'Congratulations — your evaluation qualified. Your funded account is being created.' };
    case 'FUNDED_READY':
      return { subject: 'Your funded account is ready', body: 'Your funded account is active. Good trading.' };
    case 'PAYOUT_ELIGIBLE':
      return { subject: 'You are eligible for a payout', body: 'Your funded account is eligible to request a payout.' };
    case 'PAYOUT_REQUESTED':
      return { subject: 'Payout requested', body: 'We received your payout request and are reviewing it.' };
    case 'PAYOUT_APPROVED':
      return { subject: 'Payout approved', body: 'Your payout has been approved.' };
    case 'PAYOUT_PAID':
      return { subject: 'Payout paid', body: 'Your payout has been paid.' };
    case 'REFUND':
      return { subject: 'Your purchase was refunded', body: 'Your purchase has been refunded.' };
    case 'DISPUTE_ACTION':
      return { subject: 'Action needed on your purchase', body: 'A dispute was opened on your purchase and is under review.' };
    case 'SECURITY_LOGIN':
      return { subject: 'New sign-in to your account', body: 'A new sign-in was detected on your account.' };
    case 'PASSWORD_CHANGED':
      return { subject: 'Your password was changed', body: 'Your account password was changed.' };
    case 'ACCOUNT_RESTORED':
      return { subject: 'Your account was restored', body: 'Access to your account has been restored.' };
    case 'ACCOUNT_INACTIVITY_WARNING':
      return {
        subject: 'Your funded account needs trading activity',
        body: 'Your funded account has no qualifying trading activity this month. Trade before the month ends to keep it active.',
      };
    case 'ACCOUNT_INACTIVITY_CLOSED':
      return {
        subject: 'Your funded account was closed for inactivity',
        body: 'Your funded account was closed because a calendar month completed with no qualifying trading activity. It remains in your account history.',
      };
    case 'ACCOUNT_COMPLETED':
      return {
        subject: 'Your funded account reached its payout maximum',
        body: 'Congratulations — your funded account completed its fifth payout cycle. It is now complete and moved to your account history.',
      };
    case 'CERTIFICATE_READY':
      return {
        subject: 'Your Happy Trader certificate is ready',
        body: 'A new certificate has been added to your Certificate Vault. View, download or share it from your dashboard.',
      };
  }
}

export interface EnqueueInput {
  organizationId: string;
  customerIdentityId: string | null;
  type: NotificationType;
  /** The stable id of the thing that happened (qualification id, order id, ...). */
  subjectKey: string;
  /** Explicit recipient per channel; falls back to the identity's primary contact. */
  recipientByChannel?: Partial<Record<NotificationChannel, string>>;
  data?: Record<string, unknown>;
}

/**
 * Record the INTENT to notify, at most once per (type, channel, subject). No
 * provider I/O here — the worker delivers. Unique (org, dedupe_key) makes a
 * retried event a no-op. Returns how many new rows were recorded.
 */
export async function enqueueNotification(db: Database, input: EnqueueInput): Promise<number> {
  const channels = TYPE_CHANNELS[input.type];
  const data = input.data ?? {};
  let recorded = 0;
  for (const channel of channels) {
    const recipient =
      input.recipientByChannel?.[channel] ??
      (input.customerIdentityId
        ? await primaryContactValue(db, input.customerIdentityId, channel)
        : null);
    if (!recipient) continue; // cannot address this channel yet — skip it.
    const dedupeKey = `${input.type}:${channel}:${input.customerIdentityId ?? 'none'}:${input.subjectKey}:${TEMPLATE_VERSION}`;
    const { subject, body } = render(input.type, data);
    const [row] = await db
      .insert(notificationMessages)
      .values({
        organizationId: input.organizationId,
        customerIdentityId: input.customerIdentityId,
        type: input.type,
        channel,
        recipient,
        templateVersion: TEMPLATE_VERSION,
        dedupeKey,
        status: 'PENDING',
        payload: { subject, body, to: recipient } as object,
      })
      .onConflictDoNothing({ target: [notificationMessages.organizationId, notificationMessages.dedupeKey] })
      .returning();
    if (row) recorded += 1;
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Event consumer: map committed domain events to notification intents.
// ---------------------------------------------------------------------------

async function identityIdFor(db: Database, event: DomainEvent): Promise<string | null> {
  const fromPayload = (event.payload as { customerIdentityId?: string })?.customerIdentityId;
  if (fromPayload) return fromPayload;
  if (event.userId && event.organizationId) {
    const identity = await getIdentityByUser(db, event.organizationId, event.userId);
    return identity?.id ?? null;
  }
  return null;
}

/**
 * Subscribe notification intent-recording to the event bus. A bystander that
 * defers its DB work off the publishing call stack (events.publish awaits its
 * handlers inside the caller's transaction). VERIFY_* notifications are NOT mapped
 * here — the code is not persisted in the event; contact-verification enqueues
 * those directly with the code.
 */
export function registerNotificationConsumer(db: Database): () => void {
  return events.subscribe((event) => {
    setTimeout(() => {
      void (async () => {
        if (!event.organizationId) return;
        const org = event.organizationId;
        const identityId = await identityIdFor(db, event).catch(() => null);
        const enqueue = (type: NotificationType, subjectKey: string, data?: Record<string, unknown>) =>
          enqueueNotification(db, { organizationId: org, customerIdentityId: identityId, type, subjectKey, data }).catch(() => 0);

        switch (event.type) {
          case 'customer_identity.created':
            await enqueue('WELCOME', identityId ?? 'welcome');
            break;
          case 'identity.verification_started':
            await enqueue('IDENTITY_STARTED', identityId ?? 'idstart');
            break;
          case 'identity.verified':
            await enqueue('IDENTITY_VERIFIED', identityId ?? 'idok');
            break;
          case 'identity.step_up_required':
          case 'identity.under_review':
            await enqueue('IDENTITY_ACTION_REQUIRED', `${event.type}:${identityId ?? 'id'}`);
            break;
          case 'entitlement.provisioned': {
            const orderId = (event.payload as { orderId?: string })?.orderId ?? 'order';
            await enqueue('PURCHASE_CONFIRMED', `purchase:${orderId}`);
            await enqueue('EVAL_READY', `eval:${orderId}`);
            break;
          }
          case 'evaluation.qualified': {
            const qualId = (event.payload as { qualificationId?: string })?.qualificationId ?? 'qual';
            await enqueue('EVAL_PASSED', `pass:${qualId}`);
            break;
          }
          case 'account.funded': {
            const acct = event.accountId ?? 'funded';
            await enqueue('FUNDED_READY', `funded:${acct}`);
            break;
          }
          case 'commerce.refunded': {
            const orderId = (event.payload as { orderId?: string })?.orderId ?? 'order';
            await enqueue('REFUND', `refund:${orderId}`);
            break;
          }
          case 'commerce.dispute_opened': {
            const orderId = (event.payload as { orderId?: string })?.orderId ?? 'order';
            await enqueue('DISPUTE_ACTION', `dispute:${orderId}`);
            break;
          }
          case 'payout.eligibility_unlocked':
            await enqueue('PAYOUT_ELIGIBLE', `payoutelig:${event.accountId ?? 'a'}`);
            break;
          case 'payout.requested':
            await enqueue('PAYOUT_REQUESTED', `payoutreq:${(event.payload as { payoutRequestId?: string })?.payoutRequestId ?? 'p'}`);
            break;
          case 'payout.approved':
            await enqueue('PAYOUT_APPROVED', `payoutok:${(event.payload as { payoutRequestId?: string })?.payoutRequestId ?? 'p'}`);
            break;
          case 'payout.paid':
            await enqueue('PAYOUT_PAID', `payoutpaid:${(event.payload as { payoutRequestId?: string })?.payoutRequestId ?? 'p'}`);
            break;
          default:
            break;
        }
      })();
    }, 0);
  });
}

// ---------------------------------------------------------------------------
// Delivery worker.
// ---------------------------------------------------------------------------

const RETRY_BACKOFF_MS = [0, 30_000, 120_000, 300_000, 900_000, 1_800_000];

/**
 * Deliver up to `limit` PENDING, due, non-terminal messages. Each is locked with
 * FOR UPDATE so two workers never double-send. A configured provider that fails
 * transiently retries with backoff; a permanently failed one becomes FAILED; an
 * unconfigured provider becomes SUPPRESSED (visible, not a fake SENT).
 */
export async function deliverPendingNotifications(
  db: Database,
  opts: { limit?: number; email?: EmailProvider; sms?: SmsProvider } = {},
): Promise<{ sent: number; suppressed: number; failed: number }> {
  const email = opts.email ?? emailProviderFromEnv();
  const sms = opts.sms ?? smsProviderFromEnv();
  const limit = opts.limit ?? 50;

  const due = await db
    .select({ id: notificationMessages.id })
    .from(notificationMessages)
    .where(
      and(
        eq(notificationMessages.status, 'PENDING'),
        eq(notificationMessages.terminal, false),
        lte(notificationMessages.availableAt, new Date()),
      ),
    )
    .orderBy(asc(notificationMessages.availableAt))
    .limit(limit);

  let sent = 0;
  let suppressed = 0;
  let failed = 0;

  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(notificationMessages)
        .where(eq(notificationMessages.id, id))
        .for('update');
      if (!row || row.status !== 'PENDING' || row.terminal) return;

      const payload = (row.payload ?? {}) as { subject?: string; body?: string; to?: string };
      const to = payload.to ?? row.recipient;
      const result =
        row.channel === 'EMAIL'
          ? await email.send({ to, subject: payload.subject ?? '', body: payload.body ?? '' })
          : await sms.send({ to, body: payload.body ?? '' });

      if (result.ok) {
        await tx
          .update(notificationMessages)
          .set({
            status: 'SENT',
            terminal: true,
            provider: row.channel === 'EMAIL' ? email.name : sms.name,
            providerRef: result.providerRef,
            attempts: row.attempts + 1,
            sentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(notificationMessages.id, id));
        sent += 1;
        return;
      }

      if (!result.retryable) {
        // Unconfigured / permanent: SUPPRESSED — a visible, honest not-delivered.
        await tx
          .update(notificationMessages)
          .set({
            status: 'SUPPRESSED',
            terminal: true,
            provider: row.channel === 'EMAIL' ? email.name : sms.name,
            lastError: result.error.slice(0, 200),
            attempts: row.attempts + 1,
            updatedAt: new Date(),
          })
          .where(eq(notificationMessages.id, id));
        suppressed += 1;
        return;
      }

      const attempts = row.attempts + 1;
      if (attempts >= row.maxAttempts) {
        await tx
          .update(notificationMessages)
          .set({ status: 'FAILED', terminal: true, lastError: result.error.slice(0, 200), attempts, updatedAt: new Date() })
          .where(eq(notificationMessages.id, id));
        failed += 1;
        return;
      }
      const backoff = RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)]!;
      await tx
        .update(notificationMessages)
        .set({ attempts, lastError: result.error.slice(0, 200), availableAt: new Date(Date.now() + backoff), updatedAt: new Date() })
        .where(eq(notificationMessages.id, id));
    });
  }

  return { sent, suppressed, failed };
}

/** Start the delivery loop (and drain on boot). Returns a stop function. */
export function startNotificationWorker(db: Database, intervalMs = 5_000): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    await deliverPendingNotifications(db).catch(() => undefined);
  };
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/** Owner console: a customer's notification history, newest first. */
export async function listNotificationsForIdentity(db: Database, identityId: string, limit = 100) {
  return db
    .select()
    .from(notificationMessages)
    .where(eq(notificationMessages.customerIdentityId, identityId))
    .orderBy(asc(notificationMessages.createdAt))
    .limit(limit);
}

/** Owner console: resend a notification as a NEW message (fresh dedupe suffix). */
export async function resendNotification(
  db: Database,
  id: string,
): Promise<{ requeued: boolean }> {
  const [row] = await db.select().from(notificationMessages).where(eq(notificationMessages.id, id));
  if (!row) return { requeued: false };
  const dedupeKey = `${row.dedupeKey}:resend:${Date.now()}`;
  await db.insert(notificationMessages).values({
    organizationId: row.organizationId,
    customerIdentityId: row.customerIdentityId,
    type: row.type,
    channel: row.channel,
    recipient: row.recipient,
    templateVersion: row.templateVersion,
    dedupeKey,
    status: 'PENDING',
    payload: row.payload as object,
  });
  return { requeued: true };
}
