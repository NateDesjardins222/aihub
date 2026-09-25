/**
 * The granular permission catalog for the Owner Operating System (M10).
 *
 * Authorization is by permission STRING, not by role rank. Roles are a
 * convenience that maps to a default set of these; the server always checks the
 * effective permission set (role defaults ± per-user overrides). Hiding a button
 * is presentation; `requirePermission` is the thing that decides.
 *
 * Permissions are dotted `area.action` / `area.sub.action` strings so they group
 * naturally in the UI and so a coarse `area.read` can gate a whole section.
 */

export const PERMISSIONS = [
  // Customers
  'customers.read',
  'customers.notes.write',
  'customers.tags.write',
  'customers.impersonate',
  'customers.export',
  // Accounts
  'accounts.read',
  'accounts.pause',
  'accounts.flatten',
  'accounts.hold.manage',
  'accounts.reset.request',
  'accounts.reset.approve',
  'accounts.adjust',
  'accounts.provisioning.retry',
  // Trading
  'trading.read',
  'trading.flatten',
  'orders.cancel',
  // Payouts
  'payouts.read',
  'payouts.operations',
  'payouts.adjust',
  // Enforcement
  'enforcement.read',
  'enforcement.manage',
  // Commerce
  'commerce.read',
  'refunds.request',
  'refunds.approve',
  // Rewards
  'rewards.read',
  // Finance / exports
  'finance.read',
  'exports.run',
  // System
  'system.read',
  'system.doctor.run',
  'system.integrity.run',
  'system.incidents.manage',
  'system.feature_flags.manage',
  'system.kill_switches.manage',
  'system.jobs.manage',
  'system.webhooks.manage',
  // Configuration
  'config.products.manage',
  'config.providers.manage',
  'config.notifications.manage',
  // Alerts / tasks / notes
  'alerts.read',
  'alerts.manage',
  'tasks.read',
  'tasks.manage',
  // Administration
  'staff.read',
  'staff.manage',
  'roles.manage',
  'audit.read',
  'security.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** Grouping for the UI (Administration → Roles). Not used for authorization. */
export const PERMISSION_GROUPS: Record<string, Permission[]> = {
  Customers: ['customers.read', 'customers.notes.write', 'customers.tags.write', 'customers.impersonate', 'customers.export'],
  Accounts: [
    'accounts.read', 'accounts.pause', 'accounts.flatten', 'accounts.hold.manage',
    'accounts.reset.request', 'accounts.reset.approve', 'accounts.adjust', 'accounts.provisioning.retry',
  ],
  Trading: ['trading.read', 'trading.flatten', 'orders.cancel'],
  Payouts: ['payouts.read', 'payouts.operations', 'payouts.adjust'],
  Enforcement: ['enforcement.read', 'enforcement.manage'],
  Commerce: ['commerce.read', 'refunds.request', 'refunds.approve'],
  Rewards: ['rewards.read'],
  Finance: ['finance.read', 'exports.run'],
  System: [
    'system.read', 'system.doctor.run', 'system.integrity.run', 'system.incidents.manage',
    'system.feature_flags.manage', 'system.kill_switches.manage', 'system.jobs.manage', 'system.webhooks.manage',
  ],
  Configuration: ['config.products.manage', 'config.providers.manage', 'config.notifications.manage'],
  Operations: ['alerts.read', 'alerts.manage', 'tasks.read', 'tasks.manage'],
  Administration: ['staff.read', 'staff.manage', 'roles.manage', 'audit.read', 'security.manage'],
};

/**
 * Risk classes for step-up reauthentication. A high-risk endpoint declares one;
 * `requireReauth(class)` demands a fresh step-up token scoped to it.
 */
export type ReauthClass = 'FINANCIAL' | 'STAFF' | 'KILL_SWITCH' | 'PROVIDER' | 'CONFIG' | 'BREAK_GLASS';
