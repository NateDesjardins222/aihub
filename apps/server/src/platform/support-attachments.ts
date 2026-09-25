/**
 * Support attachments (Milestone 12-I).
 *
 * Safe customer/staff uploads: strict type + size validation, executable rejection,
 * a storage ABSTRACTION (a real object store drops in behind this seam), and
 * signed, time-limited downloads — never a public predictable URL. Bytes live
 * behind the storage provider, never in a customer-reachable path, and every read
 * is authorized at the route. The storage secret is never exposed to a client.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { supportAttachments } from '../db/schema.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from './actor.js';
import { recordAudit } from './audit.js';
import { getSupportConfig } from './support-config.js';
import { getTicketRow } from './support-tickets.js';

// A pluggable storage seam. The default keeps bytes in-process (dev/test); a real
// deployment swaps in an object-store implementation with the same interface.
export interface StorageProvider {
  readonly name: string;
  configured(): boolean;
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  remove(key: string): Promise<void>;
}
class InProcessStorage implements StorageProvider {
  readonly name = 'in-process';
  private store = new Map<string, { bytes: Buffer; contentType: string }>();
  configured(): boolean { return true; }
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> { this.store.set(key, { bytes, contentType }); }
  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | null> { return this.store.get(key) ?? null; }
  async remove(key: string): Promise<void> { this.store.delete(key); }
}
let storage: StorageProvider = new InProcessStorage();
export function setSupportStorage(p: StorageProvider): void { storage = p; }
export function supportStorageStatus(): { provider: string; configured: boolean } { return { provider: storage.name, configured: storage.configured() }; }

const DANGEROUS_EXT = /\.(exe|sh|bat|cmd|com|msi|dll|scr|js|mjs|cjs|jar|app|deb|rpm|ps1|vbs|php|py|rb|pl)$/i;
const DANGEROUS_TYPES = new Set(['application/x-msdownload', 'application/x-sh', 'application/x-executable', 'application/x-msdos-program', 'text/javascript', 'application/javascript']);

export function validateUpload(filename: string, contentType: string, sizeBytes: number, settings: { maxAttachmentBytes: number; allowedAttachmentTypes: string[] }): { safeName: string } {
  const safeName = filename.replace(/[/\\]/g, '_').replace(/[^\w.\- ]/g, '').slice(0, 255) || 'file';
  if (DANGEROUS_EXT.test(safeName)) throw ApiError.badRequest('UNSAFE_FILE', 'Executable or script uploads are not allowed.');
  if (DANGEROUS_TYPES.has(contentType)) throw ApiError.badRequest('UNSAFE_TYPE', 'That file type is not allowed.');
  if (!settings.allowedAttachmentTypes.includes(contentType)) throw ApiError.badRequest('DISALLOWED_TYPE', `Files of type ${contentType} are not accepted.`);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw ApiError.badRequest('EMPTY_FILE', 'The file is empty.');
  if (sizeBytes > settings.maxAttachmentBytes) throw ApiError.badRequest('FILE_TOO_LARGE', `The file exceeds the ${(settings.maxAttachmentBytes / (1024 * 1024)).toFixed(0)} MB limit.`);
  return { safeName };
}

export async function createAttachment(db: Database, input: { ticketId: string; messageId?: string | null; uploaderType: 'CUSTOMER' | 'STAFF'; filename: string; contentType: string; bytes: Buffer; visibility?: 'CUSTOMER' | 'INTERNAL'; actor: Actor }): Promise<{ id: string }> {
  const t = await getTicketRow(db, input.ticketId);
  if (!t) throw ApiError.notFound('TICKET_NOT_FOUND', 'Support ticket not found.');
  const cfg = await getSupportConfig(db, t.organizationId);
  const { safeName } = validateUpload(input.filename, input.contentType, input.bytes.length, cfg.settings);
  const storageKey = `att_${crypto.randomUUID().replace(/-/g, '')}`;
  await storage.put(storageKey, input.bytes, input.contentType);
  const [row] = await db.insert(supportAttachments).values({
    organizationId: t.organizationId, ticketId: input.ticketId, messageId: input.messageId ?? null,
    uploaderUserId: input.actor.userId ?? null, uploaderType: input.uploaderType, filename: safeName,
    contentType: input.contentType, sizeBytes: input.bytes.length, storageKey, scanStatus: 'CLEAN',
    visibility: input.visibility ?? (input.uploaderType === 'STAFF' ? 'INTERNAL' : 'CUSTOMER'),
  }).returning();
  await recordAudit(db, { organizationId: t.organizationId, actor: input.actor, subjectType: 'SUPPORT_TICKET', subjectId: input.ticketId, action: 'support.attachment.added', newState: { attachmentId: row!.id, filename: safeName, sizeBytes: input.bytes.length } });
  return { id: row!.id };
}

export async function listAttachments(db: Database, ticketId: string, opts: { includeInternal: boolean }) {
  const rows = await db.select().from(supportAttachments).where(eq(supportAttachments.ticketId, ticketId)).orderBy(desc(supportAttachments.createdAt));
  const visible = opts.includeInternal ? rows : rows.filter((r) => r.visibility === 'CUSTOMER');
  return visible.map((r) => ({ id: r.id, filename: r.filename, contentType: r.contentType, sizeBytes: r.sizeBytes, visibility: r.visibility, uploaderType: r.uploaderType, scanStatus: r.scanStatus, createdAt: r.createdAt }));
}

export async function getAttachment(db: Database, id: string) {
  const [a] = await db.select().from(supportAttachments).where(eq(supportAttachments.id, id));
  return a ?? null;
}
export async function readAttachmentBytes(storageKey: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  return storage.get(storageKey);
}

// ---- signed, time-limited downloads ---------------------------------------
function downloadSecret(): string {
  return process.env['SUPPORT_ATTACH_SECRET'] || process.env['JWT_SECRET'] || 'dev-support-attach-secret';
}
export function signDownloadToken(attachmentId: string, ttlSeconds = 300): string {
  const exp = Date.now() + ttlSeconds * 1000;
  const mac = createHmac('sha256', downloadSecret()).update(`${attachmentId}.${exp}`).digest('hex');
  return `${exp}.${mac}`;
}
export function verifyDownloadToken(attachmentId: string, token: string): boolean {
  const [expStr, mac] = token.split('.');
  if (!expStr || !mac) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = createHmac('sha256', downloadSecret()).update(`${attachmentId}.${exp}`).digest('hex');
  try { return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)); } catch { return false; }
}

/** Authorization for reading an attachment: the ticket's customer, or staff. */
export async function canAccessAttachment(db: Database, attachmentId: string, viewer: { userId: string | null; isStaff: boolean }): Promise<boolean> {
  const a = await getAttachment(db, attachmentId);
  if (!a) return false;
  if (viewer.isStaff) return true;
  if (a.visibility === 'INTERNAL') return false; // customers never see internal attachments
  const t = await getTicketRow(db, a.ticketId);
  return !!t && t.customerUserId === viewer.userId;
}
