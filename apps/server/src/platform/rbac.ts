/**
 * Role → permission mapping and effective-permission computation (pure).
 *
 * The legacy linear roles (TRADER < SUPPORT < ADMIN < SUPER_ADMIN) are retained
 * as coarse defaults. The effective set is: the role's defaults, plus per-user
 * GRANT overrides, minus per-user DENY overrides. SUPER_ADMIN is the owner tier
 * and holds every permission; a small set of "protected" permissions can never
 * be DENYed away from a SUPER_ADMIN, so the console cannot lock the owner out of
 * its own controls.
 *
 * This module is DB-free so it is trivially unit-testable; a loader in
 * `staff.ts` reads the override rows and calls `effectivePermissions`.
 */
import { PERMISSIONS, type Permission } from './permissions.js';

export type Role = 'TRADER' | 'SUPPORT' | 'ADMIN' | 'SUPER_ADMIN';

export interface PermissionOverride {
  readonly permission: string;
  readonly effect: 'GRANT' | 'DENY';
}

/** Permissions no override can strip from a SUPER_ADMIN (owner never locks self out). */
export const PROTECTED_OWNER_PERMISSIONS: readonly Permission[] = [
  'staff.manage',
  'roles.manage',
  'security.manage',
  'system.kill_switches.manage',
  'audit.read',
];

const SUPPORT_DEFAULTS: Permission[] = [
  'customers.read',
  'customers.notes.write',
  'customers.tags.write',
  'accounts.read',
  'accounts.reset.request',
  'trading.read',
  'payouts.read',
  'enforcement.read',
  'commerce.read',
  'refunds.request',
  'rewards.read',
  'finance.read',
  'system.read',
  'audit.read',
  'alerts.read',
  'tasks.read',
  'tasks.manage',
];

// ADMIN adds operational mutations, but NOT the owner-only tier (staff/roles/
// security/kill-switches) and NOT the four-eyes financial approvals.
const ADMIN_ONLY_ADDITIONS: Permission[] = [
  'customers.impersonate',
  'customers.export',
  'accounts.pause',
  'accounts.flatten',
  'accounts.hold.manage',
  'accounts.provisioning.retry',
  'trading.flatten',
  'orders.cancel',
  'payouts.operations',
  'enforcement.manage',
  'exports.run',
  'system.doctor.run',
  'system.integrity.run',
  'system.incidents.manage',
  'system.feature_flags.manage',
  'system.jobs.manage',
  'system.webhooks.manage',
  'config.products.manage',
  'config.providers.manage',
  'config.notifications.manage',
  'alerts.manage',
  'staff.read',
];

const ADMIN_DEFAULTS: Permission[] = [...SUPPORT_DEFAULTS, ...ADMIN_ONLY_ADDITIONS];

/** SUPER_ADMIN holds everything. */
const OWNER_DEFAULTS: Permission[] = [...PERMISSIONS];

const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  TRADER: [],
  SUPPORT: SUPPORT_DEFAULTS,
  ADMIN: ADMIN_DEFAULTS,
  SUPER_ADMIN: OWNER_DEFAULTS,
};

export function roleDefaults(role: Role): Permission[] {
  return ROLE_DEFAULTS[role] ?? [];
}

/**
 * The effective permission set for a user of `role` with `overrides`.
 * DENY wins over GRANT for a given permission except for a SUPER_ADMIN's
 * protected permissions.
 */
export function effectivePermissions(role: Role, overrides: readonly PermissionOverride[] = []): Set<string> {
  const set = new Set<string>(roleDefaults(role));
  const denies = new Set<string>();
  for (const o of overrides) {
    if (o.effect === 'GRANT') set.add(o.permission);
  }
  for (const o of overrides) {
    if (o.effect === 'DENY') denies.add(o.permission);
  }
  for (const d of denies) {
    if (role === 'SUPER_ADMIN' && (PROTECTED_OWNER_PERMISSIONS as readonly string[]).includes(d)) continue;
    set.delete(d);
  }
  return set;
}

export function hasPermission(
  permission: string,
  role: Role,
  overrides: readonly PermissionOverride[] = [],
): boolean {
  return effectivePermissions(role, overrides).has(permission);
}
