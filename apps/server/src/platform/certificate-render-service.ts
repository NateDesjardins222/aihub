/**
 * Certificate render orchestration (Milestone 6).
 *
 * Ties an issued certificate RECORD to its immutable rendered ARTIFACTS: resolve
 * the template version (approved v1 preferred, else the v-test fixture, else
 * DISABLED), render deterministically, store PNG + PDF through the object store,
 * and freeze the storage keys + hash + versions onto the record. Fails SAFE — the
 * reward stays valid and verifiable even when no approved master exists yet.
 *
 * Idempotent: a certificate already RENDERED is left untouched; a re-render only
 * happens for a PENDING/FAILED record and writes to fresh (unguessable) keys, so
 * artifacts are never silently overwritten.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { certificates } from '../db/schema.js';
import { type CertificateType, templateTypeKey } from './certificates.js';
import { templateAvailable } from './certificate-manifest.js';
import { certificateRenderer } from './certificate-renderer.js';
import { objectStore, newArtifactKey } from './object-store.js';

const M = 1_000_000;

/** Canonical certificate money: "$5,000", "$25,000" (cents only when a real amount carries them). */
export function money(micros: number | null | undefined): string {
  if (micros == null) return '';
  return `$${(micros / M).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Account size in the approved compact form: $50,000 → "50K", $300,000 → "300K". */
export function accountSize(micros: number | null | undefined): string {
  if (micros == null) return '';
  const dollars = micros / M;
  // Account sizes are whole thousands; fall back to canonical money if not.
  if (dollars >= 1000 && Number.isInteger(dollars) && dollars % 1000 === 0) return `${dollars / 1000}K`;
  return money(micros);
}

/**
 * The authoritative certificate date, formatted exactly as the approved artwork
 * requires: YYYY-MM-DD, from the reward's own event timestamp in UTC (never the
 * browser clock or a locale format). Deterministic.
 */
export function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Choose the version to render: approved v1 if installed. The v-test fixture is a
 * NON-PRODUCTION calibration artifact — it is used only outside production, so a
 * production render with no approved v1 master fails CLOSED (DISABLED) rather than
 * silently shipping fixture artwork.
 */
export function resolveTemplateVersion(dirKey: string): string | null {
  if (templateAvailable(dirKey, 'v1')) return 'v1';
  if (process.env['NODE_ENV'] !== 'production' && templateAvailable(dirKey, 'v-test')) return 'v-test';
  return null;
}

type CertRow = typeof certificates.$inferSelect;

/**
 * The dynamic fields a certificate type prints. The recipient name renders in the
 * approved uppercase presentation (the immutable snapshot in the DB keeps its
 * original casing). FUNDED prints the account SIZE ("50K"); payouts/completed print
 * the actual paid amount; club milestones print the LOCKED milestone value.
 */
function fieldsFor(row: CertRow): Record<string, string> {
  const value =
    row.type === 'FUNDED_TRADER'
      ? accountSize(row.amountMicros)
      : row.type === 'TENK_CLUB' || row.type === 'FIFTYK_CLUB' || row.type === 'HUNDREDK_CLUB'
        ? money(row.milestoneValueMicros)
        : money(row.amountMicros);
  return {
    recipientName: (row.publicDisplayName ?? '').toUpperCase(),
    value,
    date: isoDate(row.issuedAt),
  };
}

export type RenderOutcome = 'RENDERED' | 'DISABLED' | 'FAILED' | 'SKIPPED';

/**
 * Render (or re-render) one certificate's artifacts and persist the result.
 * Safe to call repeatedly. Never throws — it records the outcome on the row.
 */
export async function renderCertificate(db: Database, certificateId: string): Promise<RenderOutcome> {
  const [row] = await db.select().from(certificates).where(eq(certificates.id, certificateId));
  if (!row) return 'SKIPPED';
  if (row.renderStatus === 'RENDERED') return 'SKIPPED';

  const dirKey = templateTypeKey(row.type as CertificateType);
  const version = resolveTemplateVersion(dirKey);
  if (!version) {
    await db.update(certificates).set({ renderStatus: 'DISABLED', renderError: 'No approved master installed for this type.' }).where(eq(certificates.id, certificateId));
    return 'DISABLED';
  }

  const result = await certificateRenderer().render({ templateType: dirKey, templateVersion: version, fields: fieldsFor(row) });
  if (result.status === 'DISABLED') {
    await db.update(certificates).set({ renderStatus: 'DISABLED', renderError: result.reason.slice(0, 500) }).where(eq(certificates.id, certificateId));
    return 'DISABLED';
  }
  if (result.status === 'FAILED') {
    await db.update(certificates).set({ renderStatus: 'FAILED', renderError: result.reason.slice(0, 500) }).where(eq(certificates.id, certificateId));
    return 'FAILED';
  }

  const store = objectStore();
  const imageKey = newArtifactKey(`certificates/${row.organizationId}`, `${row.certificatePublicId}.png`);
  const pdfKey = newArtifactKey(`certificates/${row.organizationId}`, `${row.certificatePublicId}.pdf`);
  await store.put(imageKey, result.png, 'image/png');
  await store.put(pdfKey, result.pdf, 'application/pdf');

  await db
    .update(certificates)
    .set({
      renderStatus: 'RENDERED',
      rendererVersion: certificateRenderer().version,
      templateVersion: version,
      imageStorageKey: imageKey,
      printStorageKey: imageKey, // the full-resolution PNG is the print artifact
      pdfStorageKey: pdfKey,
      renderHash: result.renderHash,
      renderError: null,
    })
    .where(eq(certificates.id, certificateId));
  return 'RENDERED';
}
