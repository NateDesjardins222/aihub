/**
 * Internal staff notes about a trader (Owner Control Center V3).
 *
 * Owner-side operational data. A trader never sees these; they are read and
 * written only by staff, and every read is scoped to the caller's organisation.
 * Append-only: a note is written once. If it is wrong it is superseded by a new
 * note, or redacted (its body hidden, its row kept) — never silently
 * overwritten, so the operational record cannot be quietly rewritten. Every
 * write is audited through the ordinary hash-chained recorder.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { traderNotes, users } from '../db/schema.js';
import { recordAudit } from './audit.js';
import { SYSTEM_ACTOR, type Actor } from './actor.js';

export const NOTE_CATEGORIES = ['GENERAL', 'SUPPORT', 'RISK', 'ACCOUNT'] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export class NoteError extends Error {
  constructor(
    readonly code: 'SUBJECT_NOT_FOUND' | 'NOTE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'NoteError';
  }
}

type NoteRow = typeof traderNotes.$inferSelect;

export interface PresentedNote {
  id: string;
  category: string;
  body: string | null;
  redacted: boolean;
  author: string | null;
  createdAt: number;
  redactedAt: number | null;
}

function present(row: NoteRow): PresentedNote {
  const redacted = row.redactedAt !== null;
  return {
    id: row.id,
    category: row.category,
    // A redacted note keeps its place in the record but hides its content.
    body: redacted ? null : row.body,
    redacted,
    author: row.authorLabel,
    createdAt: row.createdAt.getTime(),
    redactedAt: row.redactedAt?.getTime() ?? null,
  };
}

/** Notes about a trader, newest first. Scoped to the caller's organisation. */
export async function listNotes(
  db: Database,
  input: { organizationId: string; subjectUserId: string; limit?: number },
): Promise<PresentedNote[]> {
  const rows = await db
    .select()
    .from(traderNotes)
    .where(
      and(
        eq(traderNotes.organizationId, input.organizationId),
        eq(traderNotes.subjectUserId, input.subjectUserId),
      ),
    )
    .orderBy(desc(traderNotes.createdAt))
    .limit(Math.min(input.limit ?? 100, 200));
  return rows.map(present);
}

/**
 * Write a note about a trader. The subject must belong to the caller's
 * organisation — a note cannot be attached across a tenancy boundary.
 */
export async function createNote(
  db: Database,
  input: {
    organizationId: string;
    subjectUserId: string;
    category: NoteCategory;
    body: string;
    actor?: Actor;
  },
): Promise<PresentedNote> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const [subject] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, input.subjectUserId), eq(users.organizationId, input.organizationId)));
  if (!subject) throw new NoteError('SUBJECT_NOT_FOUND', 'No such trader in this organisation.');

  const [note] = await db
    .insert(traderNotes)
    .values({
      organizationId: input.organizationId,
      subjectUserId: input.subjectUserId,
      category: input.category,
      // Stored verbatim as text. It is never rendered as HTML; the client
      // escapes it, so tags, scripts and SQL-like text are inert content.
      body: input.body,
      authorUserId: actor.type === 'USER' || actor.type === 'ADMIN' ? (actor.userId ?? null) : null,
      authorLabel: actor.label ?? null,
    })
    .returning();

  await recordAudit(db, {
    organizationId: input.organizationId,
    actor,
    subjectType: 'USER',
    subjectId: input.subjectUserId,
    userId: input.subjectUserId,
    action: 'trader_note.created',
    newState: { noteId: note!.id, category: input.category },
    reason: null,
  });
  return present(note!);
}

/**
 * Redact a note: hide its body, keep the row. The append-only alternative to a
 * destructive delete, so the record shows a note was written and later pulled,
 * never that history was rewritten. Audited.
 */
export async function redactNote(
  db: Database,
  input: { organizationId: string; noteId: string; actor?: Actor },
): Promise<PresentedNote> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const [existing] = await db
    .select()
    .from(traderNotes)
    .where(
      and(eq(traderNotes.id, input.noteId), eq(traderNotes.organizationId, input.organizationId)),
    );
  if (!existing) throw new NoteError('NOTE_NOT_FOUND', 'No such note.');
  if (existing.redactedAt) return present(existing);

  const [updated] = await db
    .update(traderNotes)
    .set({ redactedAt: new Date(), redactedByLabel: actor.label ?? null })
    .where(eq(traderNotes.id, input.noteId))
    .returning();
  await recordAudit(db, {
    organizationId: input.organizationId,
    actor,
    subjectType: 'USER',
    subjectId: existing.subjectUserId,
    userId: existing.subjectUserId,
    action: 'trader_note.redacted',
    newState: { noteId: input.noteId },
    reason: null,
  });
  return present(updated!);
}
