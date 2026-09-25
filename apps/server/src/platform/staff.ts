/**
 * Staff & access management (M10-B).
 *
 * The owner creates Owner Console users from the console — no developer/DB
 * seeding. Onboarding is invitation-based: the owner enters email/name/role, the
 * system mints a single-use, time-limited activation token (only its hash is
 * stored), and the invitee sets THEIR OWN password. The owner never sees or
 * stores the employee's password.
 *
 * Granular permissions layer on top of the four legacy roles via
 * `staff_permissions` overrides. The root owner is protected: the last reachable
 * SUPER_ADMIN cannot be disabled, demoted, or stripped of ownership.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { staffInvitations, staffPermissions, users, refreshTokens } from '../db/schema.js';
import { hashPassword } from '../auth/password.js';
import { ApiError } from '../http/errors.js';
import { recordAudit } from './audit.js';
import type { Actor } from './actor.js';
import { effectivePermissions, roleDefaults, type PermissionOverride, type Role } from './rbac.js';

const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72h activation window

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

function isRole(v: string): v is Role {
  return v === 'TRADER' || v === 'SUPPORT' || v === 'ADMIN' || v === 'SUPER_ADMIN';
}

// ---------------------------------------------------------------------------
// Effective permissions
// ---------------------------------------------------------------------------

export async function loadOverrides(db: Database, userId: string): Promise<PermissionOverride[]> {
  const rows = await db
    .select({ permission: staffPermissions.permission, effect: staffPermissions.effect })
    .from(staffPermissions)
    .where(eq(staffPermissions.userId, userId));
  return rows.map((r) => ({ permission: r.permission, effect: r.effect === 'DENY' ? 'DENY' : 'GRANT' }));
}

export interface EffectiveAccess {
  readonly userId: string;
  readonly role: Role;
  readonly status: string;
  readonly permissions: string[];
}

/** The authoritative access snapshot used by `requirePermission`. */
export async function effectiveAccess(db: Database, userId: string): Promise<EffectiveAccess | null> {
  const [u] = await db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return null;
  const role: Role = isRole(u.role) ? u.role : 'TRADER';
  const overrides = await loadOverrides(db, userId);
  return { userId, role, status: u.status, permissions: [...effectivePermissions(role, overrides)] };
}

// ---------------------------------------------------------------------------
// Owner protection
// ---------------------------------------------------------------------------

async function countOtherActiveOwners(db: Database, exceptUserId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, 'SUPER_ADMIN'), eq(users.status, 'ACTIVE'), ne(users.id, exceptUserId)));
  return row?.n ?? 0;
}

/** Throws if the operation would remove the last reachable owner. */
export async function assertNotLastOwner(db: Database, userId: string): Promise<void> {
  const [u] = await db.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, userId));
  if (!u) throw ApiError.notFound('STAFF_NOT_FOUND', 'Staff member not found.');
  if (u.role !== 'SUPER_ADMIN') return;
  const others = await countOtherActiveOwners(db, userId);
  if (others < 1) {
    throw ApiError.conflict('LAST_OWNER_PROTECTED', 'At least one active owner must remain.');
  }
}

// ---------------------------------------------------------------------------
// Listing & detail
// ---------------------------------------------------------------------------

/** Staff = non-TRADER users. */
export async function listStaff(db: Database): Promise<
  Array<{ id: string; email: string; displayName: string; role: string; status: string; mfaEnrolled: boolean; lastLoginAt: Date | null; createdAt: Date }>
> {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      mfaEnrolled: users.mfaEnrolled,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(ne(users.role, 'TRADER'))
    .orderBy(desc(users.createdAt));
}

export async function staffDetail(db: Database, userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.role === 'TRADER') throw ApiError.notFound('STAFF_NOT_FOUND', 'Staff member not found.');
  const overrides = await loadOverrides(db, userId);
  const role: Role = isRole(u.role) ? u.role : 'TRADER';
  const [sess] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.userId, userId), sql`${refreshTokens.revokedAt} is null`, sql`${refreshTokens.expiresAt} > now()`));
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    mfaEnrolled: u.mfaEnrolled,
    invitedByUserId: u.invitedByUserId,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    roleDefaults: roleDefaults(role),
    overrides,
    effectivePermissions: [...effectivePermissions(role, overrides)],
    activeSessions: sess?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface InviteInput {
  readonly organizationId: string | null;
  readonly email: string;
  readonly displayName?: string;
  readonly role: string;
  readonly permissions?: PermissionOverride[];
  readonly invitedByUserId: string;
  readonly actor: Actor;
}

export async function inviteStaff(db: Database, input: InviteInput): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw ApiError.badRequest('INVALID_EMAIL', 'A valid email is required.');
  if (!isRole(input.role) || input.role === 'TRADER') throw ApiError.badRequest('INVALID_ROLE', 'Choose a staff role.');
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw ApiError.conflict('EMAIL_IN_USE', 'A user with that email already exists.');
  // Revoke any prior pending invite for the same email (single outstanding invite).
  await db
    .update(staffInvitations)
    .set({ status: 'REVOKED', updatedAt: new Date() })
    .where(and(eq(staffInvitations.email, email), eq(staffInvitations.status, 'INVITED')));
  const { raw, hash } = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await db
    .insert(staffInvitations)
    .values({
      organizationId: input.organizationId,
      email,
      displayName: input.displayName ?? null,
      role: input.role,
      permissions: (input.permissions ?? null) as never,
      tokenHash: hash,
      status: 'INVITED',
      invitedByUserId: input.invitedByUserId,
      expiresAt,
    })
    .returning({ id: staffInvitations.id });
  await recordAudit(db, {
    organizationId: input.organizationId,
    actor: input.actor,
    subjectType: 'USER',
    subjectId: row!.id,
    action: 'staff.invited',
    newState: { email, role: input.role },
    reason: 'staff invitation issued',
  });
  return { invitationId: row!.id, token: raw, expiresAt };
}

export async function resendInvitation(db: Database, invitationId: string, actor: Actor): Promise<{ token: string; expiresAt: Date }> {
  const [inv] = await db.select().from(staffInvitations).where(eq(staffInvitations.id, invitationId));
  if (!inv) throw ApiError.notFound('INVITE_NOT_FOUND', 'Invitation not found.');
  if (inv.status !== 'INVITED') throw ApiError.conflict('INVITE_NOT_PENDING', 'Invitation is no longer pending.');
  const { raw, hash } = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.update(staffInvitations).set({ tokenHash: hash, expiresAt, updatedAt: new Date() }).where(eq(staffInvitations.id, invitationId));
  await recordAudit(db, { organizationId: inv.organizationId, actor, subjectType: 'USER', subjectId: invitationId, action: 'staff.invite.resent', reason: 'invitation resent' });
  return { token: raw, expiresAt };
}

export async function revokeInvitation(db: Database, invitationId: string, actor: Actor): Promise<void> {
  const [inv] = await db.select().from(staffInvitations).where(eq(staffInvitations.id, invitationId));
  if (!inv) throw ApiError.notFound('INVITE_NOT_FOUND', 'Invitation not found.');
  if (inv.status !== 'INVITED') return;
  await db.update(staffInvitations).set({ status: 'REVOKED', updatedAt: new Date() }).where(eq(staffInvitations.id, invitationId));
  await recordAudit(db, { organizationId: inv.organizationId, actor, subjectType: 'USER', subjectId: invitationId, action: 'staff.invite.revoked', reason: 'invitation revoked' });
}

export interface AcceptInput {
  readonly token: string;
  readonly password: string;
  readonly displayName?: string;
}

/** The invitee accepts: sets their own password, becomes ACTIVE staff. */
export async function acceptInvitation(db: Database, input: AcceptInput): Promise<{ userId: string; email: string; role: string }> {
  if (!input.password || input.password.length < 10) {
    throw ApiError.badRequest('WEAK_PASSWORD', 'Password must be at least 10 characters.');
  }
  const hash = hashToken(input.token);
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(staffInvitations).where(eq(staffInvitations.tokenHash, hash)).for('update');
    if (!inv) throw ApiError.notFound('INVITE_NOT_FOUND', 'Invitation is invalid.');
    if (inv.status === 'ACCEPTED') throw ApiError.conflict('INVITE_USED', 'Invitation has already been used.');
    if (inv.status !== 'INVITED') throw ApiError.conflict('INVITE_INACTIVE', 'Invitation is no longer valid.');
    if (inv.expiresAt.getTime() < Date.now()) {
      await tx.update(staffInvitations).set({ status: 'EXPIRED', updatedAt: new Date() }).where(eq(staffInvitations.id, inv.id));
      throw ApiError.conflict('INVITE_EXPIRED', 'Invitation has expired.');
    }
    const [dupe] = await tx.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
    if (dupe) throw ApiError.conflict('EMAIL_IN_USE', 'A user with that email already exists.');
    const passwordHash = await hashPassword(input.password);
    const displayName = (input.displayName ?? inv.displayName ?? inv.email.split('@')[0] ?? 'Staff').slice(0, 60);
    const [u] = await tx
      .insert(users)
      .values({
        email: inv.email,
        passwordHash,
        displayName,
        role: inv.role,
        isAdmin: inv.role === 'ADMIN' || inv.role === 'SUPER_ADMIN',
        status: 'ACTIVE',
        organizationId: inv.organizationId,
        invitedByUserId: inv.invitedByUserId,
      })
      .returning({ id: users.id });
    const overrides = (inv.permissions ?? null) as PermissionOverride[] | null;
    if (overrides && Array.isArray(overrides)) {
      for (const o of overrides) {
        if (!o?.permission) continue;
        await tx.insert(staffPermissions).values({
          organizationId: inv.organizationId,
          userId: u!.id,
          permission: o.permission,
          effect: o.effect === 'DENY' ? 'DENY' : 'GRANT',
          grantedByUserId: inv.invitedByUserId,
          reason: 'applied from invitation',
        });
      }
    }
    await tx.update(staffInvitations).set({ status: 'ACCEPTED', acceptedUserId: u!.id, acceptedAt: new Date(), updatedAt: new Date() }).where(eq(staffInvitations.id, inv.id));
    await recordAudit(tx as unknown as Database, {
      organizationId: inv.organizationId,
      actor: { type: 'USER', userId: u!.id, label: inv.email },
      subjectType: 'USER',
      subjectId: u!.id,
      action: 'staff.invite.accepted',
      newState: { role: inv.role },
      reason: 'staff activated own account',
    });
    return { userId: u!.id, email: inv.email, role: inv.role };
  });
}

export async function listInvitations(db: Database) {
  return db
    .select({
      id: staffInvitations.id,
      email: staffInvitations.email,
      role: staffInvitations.role,
      status: staffInvitations.status,
      invitedByUserId: staffInvitations.invitedByUserId,
      expiresAt: staffInvitations.expiresAt,
      createdAt: staffInvitations.createdAt,
    })
    .from(staffInvitations)
    .orderBy(desc(staffInvitations.createdAt))
    .limit(200);
}

// ---------------------------------------------------------------------------
// Lifecycle mutations (owner-protected)
// ---------------------------------------------------------------------------

export async function changeRole(db: Database, userId: string, role: string, actor: Actor): Promise<void> {
  if (!isRole(role) || role === 'TRADER') throw ApiError.badRequest('INVALID_ROLE', 'Choose a staff role.');
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw ApiError.notFound('STAFF_NOT_FOUND', 'Staff member not found.');
  if (u.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') await assertNotLastOwner(db, userId);
  await db.update(users).set({ role, isAdmin: role === 'ADMIN' || role === 'SUPER_ADMIN', updatedAt: new Date() }).where(eq(users.id, userId));
  await recordAudit(db, { organizationId: u.organizationId, actor, subjectType: 'USER', subjectId: userId, action: 'staff.role.changed', prevState: { role: u.role }, newState: { role }, reason: 'role changed' });
}

export async function setStatus(db: Database, userId: string, status: 'ACTIVE' | 'DISABLED', actor: Actor, action: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.role === 'TRADER') throw ApiError.notFound('STAFF_NOT_FOUND', 'Staff member not found.');
  if (status === 'DISABLED') await assertNotLastOwner(db, userId);
  await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
  if (status === 'DISABLED') {
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), sql`${refreshTokens.revokedAt} is null`));
  }
  await recordAudit(db, { organizationId: u.organizationId, actor, subjectType: 'USER', subjectId: userId, action, prevState: { status: u.status }, newState: { status }, reason: action });
}

export async function setPermissionOverride(
  db: Database,
  userId: string,
  permission: string,
  effect: 'GRANT' | 'DENY' | 'CLEAR',
  actor: Actor,
): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.role === 'TRADER') throw ApiError.notFound('STAFF_NOT_FOUND', 'Staff member not found.');
  if (effect === 'CLEAR') {
    await db.delete(staffPermissions).where(and(eq(staffPermissions.userId, userId), eq(staffPermissions.permission, permission)));
  } else {
    const [existing] = await db
      .select({ id: staffPermissions.id })
      .from(staffPermissions)
      .where(and(eq(staffPermissions.userId, userId), eq(staffPermissions.permission, permission)));
    if (existing) {
      await db.update(staffPermissions).set({ effect, grantedByUserId: actor.userId ?? null }).where(eq(staffPermissions.id, existing.id));
    } else {
      await db.insert(staffPermissions).values({ organizationId: u.organizationId, userId, permission, effect, grantedByUserId: actor.userId ?? null });
    }
  }
  await recordAudit(db, { organizationId: u.organizationId, actor, subjectType: 'USER', subjectId: userId, action: 'staff.permission.changed', newState: { permission, effect }, reason: 'permission override changed' });
}

export async function revokeStaffSessions(db: Database, userId: string, actor: Actor): Promise<number> {
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), sql`${refreshTokens.revokedAt} is null`))
    .returning({ id: refreshTokens.id });
  await recordAudit(db, { organizationId: null, actor, subjectType: 'USER', subjectId: userId, action: 'staff.sessions.revoked', newState: { revoked: rows.length }, reason: 'sessions revoked' });
  return rows.length;
}
