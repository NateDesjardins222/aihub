/**
 * Certificates — event-driven, idempotent, publicly verifiable recognition
 * (docs/certificates-achievements-v1.md §1–2).
 *
 * A deferred subscriber issues a certificate on each authoritative lifecycle
 * event, exactly once per triggering event (unique dedupe key +
 * onConflictDoNothing). A certificate carries ONLY a SAFE public display name
 * (first name + last initial, or a trader-chosen preferred name) — never the
 * legal name, email, phone, KYC data, or private ids (EMAIL IS NOT THE PERSON).
 * The public /verify/:token projection exposes only safe fields.
 */
import { randomBytes, createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { certificates, customerIdentities, users } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { events } from './events.js';
import { ensureCustomerIdentity } from './customer-identity.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';

export type CertificateType =
  | 'EVALUATION_PASSED'
  | 'FUNDED_TRADER'
  | 'PAYOUT'
  | 'ACCOUNT_COMPLETED'
  // Milestone 6 clubs (customer-level, one per identity).
  | 'TENK_CLUB'
  | 'FIFTYK_CLUB'
  | 'HUNDREDK_CLUB';

const TEMPLATE_VERSION = 'v1';

/** The certificate types whose approved artwork is renderable / framable. */
export const RENDERABLE_TYPES: readonly CertificateType[] = [
  'FUNDED_TRADER', 'PAYOUT', 'ACCOUNT_COMPLETED', 'TENK_CLUB', 'FIFTYK_CLUB',
];

/**
 * A framed physical copy may be ordered for a rendered certificate — every
 * renderable type except the 100K club, which is a manual plaque with its own
 * fulfillment path.
 */
export function isPhysicalEligibleType(type: string): boolean {
  return RENDERABLE_TYPES.includes(type as CertificateType);
}

/** The manifest directory name for a certificate type. */
export function templateTypeKey(type: CertificateType): string {
  return (
    {
      EVALUATION_PASSED: 'evaluation-passed',
      FUNDED_TRADER: 'funded-trader',
      PAYOUT: 'payout',
      ACCOUNT_COMPLETED: 'account-completed',
      TENK_CLUB: '10k-club',
      FIFTYK_CLUB: '50k-club',
      HUNDREDK_CLUB: '100k-club',
    } as Record<CertificateType, string>
  )[type];
}

/**
 * Validate a customer-chosen certificate display name. Rejects blank, control
 * characters, markup/script, and absurd lengths. Not subjective censorship —
 * only technical/safety validation so the name renders and cannot inject markup.
 */
export function validateCertificateDisplayName(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: 'A certificate name cannot be blank.' };
  if (value.length > 60) return { ok: false, reason: 'A certificate name is at most 60 characters.' };
  // No control chars (incl. newlines/tabs), no angle brackets, no ampersand-escapes.
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: 'A certificate name cannot contain control characters.' };
  if (/[<>]/.test(value)) return { ok: false, reason: 'A certificate name cannot contain markup characters.' };
  if (value.includes('@')) return { ok: false, reason: 'A certificate name cannot be an email address.' };
  return { ok: true, value };
}

/**
 * Derive a SAFE public display name. Prefers the trader's chosen preferred name;
 * otherwise first name + last initial of the display name. NEVER returns an
 * email, phone or the full legal name verbatim (if the display name looks like an
 * email, only the local part's first token is used, still reduced).
 */
export function safePublicDisplayName(preferred: string | null, displayName: string | null): string {
  const chosen = preferred?.trim();
  if (chosen) return chosen.slice(0, 80);
  const raw = (displayName ?? '').trim();
  if (!raw) return 'Happy Trader';
  // Never leak an email address.
  const base = raw.includes('@') ? (raw.split('@')[0] ?? '') : raw;
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Happy Trader';
  if (parts.length === 1) return parts[0]!.slice(0, 40);
  const first = parts[0]!;
  const lastInitial = parts[parts.length - 1]![0]!.toUpperCase();
  return `${first} ${lastInitial}.`.slice(0, 80);
}

/** A short, human, non-guessable public certificate id (HT-C-XXXXXXXX). */
function makePublicId(dedupeKey: string): string {
  const h = createHash('sha256').update(dedupeKey).digest('hex').slice(0, 8).toUpperCase();
  return `HT-C-${h}`;
}
/** A random, URL/QR-safe verification token. */
function makeToken(): string {
  return randomBytes(24).toString('base64url');
}

async function resolveSafeName(db: Database, userId: string, identityId: string): Promise<string> {
  const [ident] = await db
    .select({ preferred: customerIdentities.preferredDisplayName })
    .from(customerIdentities)
    .where(eq(customerIdentities.id, identityId));
  const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId));
  return safePublicDisplayName(ident?.preferred ?? null, user?.displayName ?? null);
}

export interface IssueCertificateInput {
  organizationId: string;
  userId: string;
  accountId: string | null;
  type: CertificateType;
  dedupeKey: string;
  amountMicros?: number | null;
  /** The LOCKED milestone label value for club certificates ($10k/$50k/$100k). */
  milestoneValueMicros?: number | null;
  templateVersion?: string;
  actor?: Actor;
}

/**
 * Issue a certificate, exactly once per dedupe key. Returns the row (new or the
 * existing one on a duplicate). Resolves/creates the customer identity so the
 * certificate is tied to the permanent identity spine, and derives the SAFE
 * public display name at issuance.
 */
export async function issueCertificate(db: Database, input: IssueCertificateInput) {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const identity = await ensureCustomerIdentity(db, {
    organizationId: input.organizationId,
    userId: input.userId,
  });
  const publicDisplayName = await resolveSafeName(db, input.userId, identity.id);

  const [row] = await db
    .insert(certificates)
    .values({
      organizationId: input.organizationId,
      certificatePublicId: makePublicId(`${input.organizationId}:${input.dedupeKey}`),
      verificationToken: makeToken(),
      type: input.type,
      customerIdentityId: identity.id,
      accountId: input.accountId,
      publicDisplayName,
      amountMicros: input.amountMicros ?? null,
      milestoneValueMicros: input.milestoneValueMicros ?? null,
      templateVersion: input.templateVersion ?? TEMPLATE_VERSION,
      renderStatus: 'PENDING',
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: [certificates.organizationId, certificates.dedupeKey] })
    .returning();

  if (!row) {
    // A concurrent issuance won; return the existing certificate.
    const [existing] = await db
      .select()
      .from(certificates)
      .where(and(eq(certificates.organizationId, input.organizationId), eq(certificates.dedupeKey, input.dedupeKey)));
    return existing ?? null;
  }

  await recordAudit(db, {
    organizationId: input.organizationId,
    actor,
    subjectType: 'ACCOUNT',
    subjectId: input.accountId ?? row.id,
    accountId: input.accountId,
    userId: input.userId,
    action: 'certificate.issued',
    newState: { certificateId: row.id, type: row.type, publicId: row.certificatePublicId },
    reason: null,
  });
  await events.publish(db, {
    type: 'certificate.issued',
    organizationId: input.organizationId,
    accountId: input.accountId,
    userId: input.userId,
    payload: { certificateId: row.id, type: row.type, certificatePublicId: row.certificatePublicId },
  });
  return row;
}

/** Revoke a certificate (the one controlled mutation), audited + evented. */
export async function revokeCertificate(
  db: Database,
  certificateId: string,
  reason: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<void> {
  const [row] = await db.select().from(certificates).where(eq(certificates.id, certificateId));
  if (!row || row.status === 'REVOKED') return;
  await db
    .update(certificates)
    .set({ status: 'REVOKED', revokedReason: reason.slice(0, 2000) })
    .where(and(eq(certificates.id, certificateId), eq(certificates.status, 'ISSUED')));
  await recordAudit(db, {
    organizationId: row.organizationId,
    actor,
    subjectType: 'ACCOUNT',
    subjectId: row.accountId ?? row.id,
    accountId: row.accountId,
    action: 'certificate.revoked',
    prevState: { status: 'ISSUED' },
    newState: { status: 'REVOKED', reason: reason.slice(0, 200) },
    reason: null,
  });
  await events.publish(db, {
    type: 'certificate.revoked',
    organizationId: row.organizationId,
    accountId: row.accountId,
    payload: { certificateId, reason: reason.slice(0, 200) },
  });
}

/** The ONLY fields a public verification exposes. No legal identity, ever. */
export interface PublicCertificate {
  valid: boolean;
  status: 'ISSUED' | 'REVOKED' | 'UNKNOWN';
  certificatePublicId: string | null;
  type: CertificateType | null;
  publicDisplayName: string | null;
  amountMicros: number | null;
  milestoneValueMicros: number | null;
  issuedMonth: string | null; // "YYYY-MM"
}

/**
 * Public verification projection for `/verify/:token`. Returns only safe fields.
 * An unknown or revoked token returns an explicit invalid state with no
 * enumeration signal beyond valid/invalid (tokens are random).
 */
export async function publicVerification(db: Database, token: string): Promise<PublicCertificate> {
  const [row] = await db.select().from(certificates).where(eq(certificates.verificationToken, token));
  if (!row) {
    return { valid: false, status: 'UNKNOWN', certificatePublicId: null, type: null, publicDisplayName: null, amountMicros: null, milestoneValueMicros: null, issuedMonth: null };
  }
  const issuedMonth = `${row.issuedAt.getUTCFullYear()}-${String(row.issuedAt.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    valid: row.status === 'ISSUED',
    status: row.status === 'ISSUED' ? 'ISSUED' : 'REVOKED',
    certificatePublicId: row.certificatePublicId,
    type: row.type as CertificateType,
    publicDisplayName: row.publicDisplayName,
    amountMicros: row.amountMicros ?? null,
    milestoneValueMicros: row.milestoneValueMicros ?? null,
    issuedMonth,
  };
}

/** A trader's own certificates (owner-scoped by identity), newest first. */
export async function listCertificatesForUser(db: Database, userId: string) {
  const [identity] = await db
    .select({ id: customerIdentities.id })
    .from(customerIdentities)
    .where(eq(customerIdentities.userId, userId));
  if (!identity) return [];
  const rows = await db
    .select()
    .from(certificates)
    .where(eq(certificates.customerIdentityId, identity.id))
    .orderBy(desc(certificates.issuedAt));
  return rows.map((r) => ({
    id: r.id,
    certificatePublicId: r.certificatePublicId,
    verificationToken: r.verificationToken,
    type: r.type,
    accountId: r.accountId,
    publicDisplayName: r.publicDisplayName,
    amountMicros: r.amountMicros ?? null,
    milestoneValueMicros: r.milestoneValueMicros ?? null,
    status: r.status,
    // Milestone 6: rendered-artifact state for the Certificate Vault.
    renderStatus: r.renderStatus,
    hasImage: r.imageStorageKey != null,
    hasPdf: r.pdfStorageKey != null,
    physicalEligible: r.status === 'ISSUED' && r.renderStatus === 'RENDERED' && isPhysicalEligibleType(r.type),
    templateVersion: r.templateVersion,
    issuedAt: r.issuedAt.getTime(),
  }));
}
