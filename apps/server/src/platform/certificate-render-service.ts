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

function money(micros: number | null | undefined): string {
  if (micros == null) return '';
  return `$${(micros / M).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthYear(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Choose the version to render: approved v1 if installed, else the v-test fixture. */
export function resolveTemplateVersion(dirKey: string): string | null {
  if (templateAvailable(dirKey, 'v1')) return 'v1';
  if (templateAvailable(dirKey, 'v-test')) return 'v-test';
  return null;
}

type CertRow = typeof certificates.$inferSelect;

/** The dynamic fields a certificate type prints (value = the type's headline number). */
function fieldsFor(row: CertRow): Record<string, string> {
  const value =
    row.type === 'TENK_CLUB' || row.type === 'FIFTYK_CLUB' || row.type === 'HUNDREDK_CLUB'
      ? money(row.milestoneValueMicros)
      : money(row.amountMicros);
  return {
    recipientName: row.publicDisplayName,
    value,
    date: monthYear(row.issuedAt),
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
