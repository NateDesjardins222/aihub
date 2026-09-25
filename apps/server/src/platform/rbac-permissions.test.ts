/**
 * Owner OS permission catalog + RBAC breadth (M10-B/L). Pure, DB-free invariants
 * over the granular permission model. These prove the catalog is well-formed, the
 * UI grouping matches the catalog exactly, the role tiers hold the privilege
 * boundaries the product requires (SUPPORT reads, ADMIN operates, owner-only tier
 * is owner-only), and the owner can never be locked out of protected controls.
 */
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_GROUPS, isPermission, type Permission } from './permissions.js';
import { effectivePermissions, hasPermission, roleDefaults, PROTECTED_OWNER_PERMISSIONS } from './rbac.js';

const OWNER_ONLY: Permission[] = [
  'staff.manage', 'roles.manage', 'security.manage', 'system.kill_switches.manage',
  'accounts.reset.approve', 'accounts.adjust', 'payouts.adjust', 'refunds.approve',
];
const ADMIN_OPERATIONAL: Permission[] = [
  'accounts.pause', 'accounts.flatten', 'orders.cancel', 'payouts.operations',
  'enforcement.manage', 'system.doctor.run', 'system.feature_flags.manage', 'staff.read',
];
const SUPPORT_FORBIDDEN: Permission[] = [
  'accounts.pause', 'accounts.adjust', 'orders.cancel', 'payouts.operations',
  'staff.read', 'staff.manage', 'roles.manage', 'security.manage', 'system.kill_switches.manage',
];

describe('permission catalog integrity', () => {
  it('has no duplicate permissions', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it.each(PERMISSIONS)('permission "%s" is a dotted lower-case area.action string', (p) => {
    expect(p).toMatch(/^[a-z]+(?:\.[a-z_]+)+$/);
    expect(isPermission(p)).toBe(true);
  });

  it('isPermission rejects an unknown string', () => {
    expect(isPermission('customers.delete_everything')).toBe(false);
    expect(isPermission('')).toBe(false);
  });

  it('the UI grouping covers the catalog exactly (no missing, no extras)', () => {
    const grouped = new Set(Object.values(PERMISSION_GROUPS).flat());
    expect(grouped.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(grouped.has(p)).toBe(true);
  });

  it.each(Object.entries(PERMISSION_GROUPS))('group "%s" references only real permissions', (_name, perms) => {
    for (const p of perms) expect(isPermission(p)).toBe(true);
  });

  it('every protected owner permission exists in the catalog', () => {
    for (const p of PROTECTED_OWNER_PERMISSIONS) expect(isPermission(p)).toBe(true);
  });
});

describe('role privilege boundaries', () => {
  it('TRADER holds no owner-console permissions', () => {
    expect(roleDefaults('TRADER')).toHaveLength(0);
  });

  it.each(PERMISSIONS)('SUPER_ADMIN holds "%s"', (p) => {
    expect(hasPermission(p, 'SUPER_ADMIN')).toBe(true);
  });

  it.each(OWNER_ONLY)('ADMIN does NOT hold owner-only "%s"', (p) => {
    expect(hasPermission(p, 'ADMIN')).toBe(false);
  });

  it.each(ADMIN_OPERATIONAL)('ADMIN holds operational "%s"', (p) => {
    expect(hasPermission(p, 'ADMIN')).toBe(true);
  });

  it.each(SUPPORT_FORBIDDEN)('SUPPORT does NOT hold mutating "%s"', (p) => {
    expect(hasPermission(p, 'SUPPORT')).toBe(false);
  });

  it('SUPPORT can read customers and accounts', () => {
    expect(hasPermission('customers.read', 'SUPPORT')).toBe(true);
    expect(hasPermission('accounts.read', 'SUPPORT')).toBe(true);
  });
});

describe('per-user overrides', () => {
  it('a GRANT adds a permission the role lacks', () => {
    expect(hasPermission('accounts.adjust', 'ADMIN', [{ permission: 'accounts.adjust', effect: 'GRANT' }])).toBe(true);
  });

  it('a DENY removes a permission the role has', () => {
    expect(hasPermission('accounts.pause', 'ADMIN', [{ permission: 'accounts.pause', effect: 'DENY' }])).toBe(false);
  });

  it('DENY wins over GRANT for the same permission', () => {
    const eff = effectivePermissions('SUPPORT', [
      { permission: 'exports.run', effect: 'GRANT' },
      { permission: 'exports.run', effect: 'DENY' },
    ]);
    expect(eff.has('exports.run')).toBe(false);
  });

  it('a GRANT is scoped to exactly that permission', () => {
    const eff = effectivePermissions('SUPPORT', [{ permission: 'orders.cancel', effect: 'GRANT' }]);
    expect(eff.has('orders.cancel')).toBe(true);
    expect(eff.has('trading.flatten')).toBe(false);
  });

  it.each(PROTECTED_OWNER_PERMISSIONS)('a DENY of protected "%s" is ignored for SUPER_ADMIN', (p) => {
    expect(hasPermission(p, 'SUPER_ADMIN', [{ permission: p, effect: 'DENY' }])).toBe(true);
  });

  it.each(PROTECTED_OWNER_PERMISSIONS)('a DENY of "%s" still applies to a granted ADMIN', (p) => {
    const ok = hasPermission(p, 'ADMIN', [{ permission: p, effect: 'GRANT' }]);
    const denied = hasPermission(p, 'ADMIN', [
      { permission: p, effect: 'GRANT' },
      { permission: p, effect: 'DENY' },
    ]);
    expect(ok).toBe(true);
    expect(denied).toBe(false);
  });

  it('repeated grants never duplicate in the effective set', () => {
    const eff = effectivePermissions('ADMIN', [
      { permission: 'accounts.adjust', effect: 'GRANT' },
      { permission: 'accounts.adjust', effect: 'GRANT' },
    ]);
    expect([...eff].filter((p) => p === 'accounts.adjust')).toHaveLength(1);
  });
});
