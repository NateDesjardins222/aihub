/**
 * Granular RBAC (M10-B) — pure permission logic. No DB.
 */
import { describe, expect, it } from 'vitest';
import { effectivePermissions, hasPermission, roleDefaults, PROTECTED_OWNER_PERMISSIONS } from './rbac.js';
import { PERMISSIONS } from './permissions.js';

describe('role defaults', () => {
  it('TRADER has no owner-console permissions', () => {
    expect(roleDefaults('TRADER')).toHaveLength(0);
  });
  it('SUPER_ADMIN holds every permission in the catalog', () => {
    const owner = new Set(roleDefaults('SUPER_ADMIN'));
    for (const p of PERMISSIONS) expect(owner.has(p)).toBe(true);
  });
  it('SUPPORT is read-oriented: can read customers but not adjust accounts', () => {
    expect(hasPermission('customers.read', 'SUPPORT')).toBe(true);
    expect(hasPermission('accounts.adjust', 'SUPPORT')).toBe(false);
    expect(hasPermission('payouts.operations', 'SUPPORT')).toBe(false);
  });
  it('ADMIN can operate accounts/payouts but not manage staff/roles/kill-switches', () => {
    expect(hasPermission('accounts.pause', 'ADMIN')).toBe(true);
    expect(hasPermission('payouts.operations', 'ADMIN')).toBe(true);
    expect(hasPermission('staff.manage', 'ADMIN')).toBe(false);
    expect(hasPermission('roles.manage', 'ADMIN')).toBe(false);
    expect(hasPermission('system.kill_switches.manage', 'ADMIN')).toBe(false);
    expect(hasPermission('accounts.adjust', 'ADMIN')).toBe(false);
    expect(hasPermission('refunds.approve', 'ADMIN')).toBe(false);
  });
  it('four-eyes financial approvals are owner-only', () => {
    expect(hasPermission('accounts.reset.approve', 'SUPER_ADMIN')).toBe(true);
    expect(hasPermission('accounts.reset.approve', 'ADMIN')).toBe(false);
    expect(hasPermission('refunds.approve', 'ADMIN')).toBe(false);
    expect(hasPermission('accounts.adjust', 'SUPER_ADMIN')).toBe(true);
  });
});

describe('per-user overrides', () => {
  it('a GRANT adds a permission the role lacks', () => {
    expect(hasPermission('accounts.adjust', 'SUPPORT')).toBe(false);
    expect(hasPermission('accounts.adjust', 'SUPPORT', [{ permission: 'accounts.adjust', effect: 'GRANT' }])).toBe(true);
  });
  it('a DENY removes a permission the role has', () => {
    expect(hasPermission('customers.read', 'ADMIN')).toBe(true);
    expect(hasPermission('customers.read', 'ADMIN', [{ permission: 'customers.read', effect: 'DENY' }])).toBe(false);
  });
  it('DENY wins over GRANT for the same permission (least privilege)', () => {
    const overrides = [
      { permission: 'payouts.adjust', effect: 'GRANT' as const },
      { permission: 'payouts.adjust', effect: 'DENY' as const },
    ];
    expect(hasPermission('payouts.adjust', 'ADMIN', overrides)).toBe(false);
  });
  it('a granted TRADER permission is scoped to exactly that permission', () => {
    const set = effectivePermissions('TRADER', [{ permission: 'system.read', effect: 'GRANT' }]);
    expect(set.has('system.read')).toBe(true);
    expect(set.has('system.doctor.run')).toBe(false);
    expect(set.size).toBe(1);
  });
});

describe('owner cannot be locked out of protected controls', () => {
  for (const p of PROTECTED_OWNER_PERMISSIONS) {
    it(`DENY of ${p} is ignored for SUPER_ADMIN`, () => {
      expect(hasPermission(p, 'SUPER_ADMIN', [{ permission: p, effect: 'DENY' }])).toBe(true);
    });
    it(`DENY of ${p} still applies to ADMIN when granted`, () => {
      const granted = hasPermission(p, 'ADMIN', [{ permission: p, effect: 'GRANT' }]);
      const denied = hasPermission(p, 'ADMIN', [
        { permission: p, effect: 'GRANT' },
        { permission: p, effect: 'DENY' },
      ]);
      expect(granted).toBe(true);
      expect(denied).toBe(false);
    });
  }
});

describe('effective set stability', () => {
  it('is a Set with no duplicates even with repeated grants', () => {
    const set = effectivePermissions('ADMIN', [
      { permission: 'accounts.pause', effect: 'GRANT' },
      { permission: 'accounts.pause', effect: 'GRANT' },
    ]);
    const arr = [...set];
    expect(new Set(arr).size).toBe(arr.length);
  });
});
