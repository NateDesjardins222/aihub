/**
 * Support program configuration + the domain constants (Milestone 12).
 *
 * Categories, SLA policies, priorities, teams, resolution codes, remediation types
 * and the ticket lifecycle live here as configurable data, not scattered frontend
 * constants. Config is versioned (a new row per change, history preserved), exactly
 * like the affiliate program config. Reasonable defaults are seeded on first read.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { supportCategories, supportConfig, supportSlaPolicies } from '../db/schema.js';
import type { Actor } from './actor.js';
import { recordAudit } from './audit.js';

// ---------------------------------------------------------------------------
// Lifecycle + enums (server-authoritative; the web mirrors these labels)
// ---------------------------------------------------------------------------
export const TICKET_STATUSES = [
  'OPEN', 'TRIAGED', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL',
  'WAITING_ON_PROVIDER', 'ESCALATED', 'RESOLVED', 'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses in which the SLA clock is paused when the policy pauses on waiting. */
export const WAITING_STATUSES: TicketStatus[] = ['WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'WAITING_ON_PROVIDER'];
export const TERMINAL_STATUSES: TicketStatus[] = ['RESOLVED', 'CLOSED'];

/** Allowed transitions. Reopen (RESOLVED/CLOSED → OPEN) is handled by its own path. */
const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ['TRIAGED', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'WAITING_ON_PROVIDER', 'ESCALATED', 'RESOLVED'],
  TRIAGED: ['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'WAITING_ON_PROVIDER', 'ESCALATED', 'RESOLVED'],
  IN_PROGRESS: ['WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'WAITING_ON_PROVIDER', 'ESCALATED', 'RESOLVED', 'TRIAGED'],
  WAITING_ON_CUSTOMER: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'TRIAGED'],
  WAITING_ON_INTERNAL: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'TRIAGED'],
  WAITING_ON_PROVIDER: ['IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'TRIAGED'],
  ESCALATED: ['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'WAITING_ON_INTERNAL', 'WAITING_ON_PROVIDER', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
};
export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type Priority = (typeof PRIORITIES)[number];
export function isPriority(v: string): v is Priority {
  return (PRIORITIES as readonly string[]).includes(v);
}

export const SUPPORT_TEAMS = [
  'GENERAL_SUPPORT', 'TRADING_OPERATIONS', 'PAYOUT_OPERATIONS', 'BILLING',
  'RISK_ENFORCEMENT', 'TECHNICAL_OPERATIONS', 'AFFILIATES',
] as const;
export type SupportTeam = (typeof SUPPORT_TEAMS)[number];

export const RESOLUTION_CODES = [
  'EXPLANATION_ONLY', 'CUSTOMER_EDUCATION', 'REMEDIATION_COMPLETED',
  'PROVIDER_ISSUE', 'INCIDENT_RESOLVED', 'NO_PLATFORM_ERROR_FOUND', 'DUPLICATE',
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

export const ROOT_CAUSE_CATEGORIES = [
  'EXPECTED_BEHAVIOR', 'CUSTOMER_EDUCATION', 'HAPPY_TRADER_SOFTWARE', 'MARKET_DATA',
  'EXECUTION_PROVIDER', 'PAYOUT_PROVIDER', 'COMMERCE_PROVIDER', 'IDENTITY_PROVIDER',
  'BILLING_ERROR', 'CONFIGURATION', 'UNKNOWN',
] as const;
export type RootCauseCategory = (typeof ROOT_CAUSE_CATEGORIES)[number];

export const REMEDIATION_TYPES = [
  'COURTESY_RESET', 'TECHNICAL_RESET', 'ACCOUNT_ADJUSTMENT', 'TRADING_REMEDIATION',
  'REFUND', 'PURCHASE_CORRECTION', 'PAYOUT_CORRECTION', 'CERTIFICATE_CORRECTION',
  'ACCESS_RESTORATION', 'OTHER',
] as const;
export type RemediationType = (typeof REMEDIATION_TYPES)[number];

export const REMEDIATION_STATUSES = ['REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'DENIED', 'EXECUTING', 'EXECUTED', 'FAILED'] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

/** Object types a ticket may link to (validated so a customer cannot forge a link). */
export const LINKABLE_OBJECT_TYPES = [
  'account', 'order', 'execution', 'position', 'purchase', 'reset', 'payout',
  'payout_operation', 'enforcement_case', 'appeal', 'certificate', 'affiliate',
  'commission', 'incident', 'job', 'webhook', 'agreement', 'session',
] as const;
export type LinkableObjectType = (typeof LINKABLE_OBJECT_TYPES)[number];

// ---------------------------------------------------------------------------
// Default category tree (configurable; seeded on first read)
// ---------------------------------------------------------------------------
interface CategorySeed { key: string; parentKey?: string; label: string; team?: SupportTeam; defaultPriority?: Priority }
export const DEFAULT_CATEGORIES: CategorySeed[] = [
  { key: 'ACCOUNT', label: 'Account', team: 'GENERAL_SUPPORT' },
  { key: 'TRADING', label: 'Trading / Order', team: 'TRADING_OPERATIONS' },
  { key: 'TRADING.ORDER_REJECTED', parentKey: 'TRADING', label: 'Order rejected', team: 'TRADING_OPERATIONS' },
  { key: 'TRADING.ORDER_MISSING', parentKey: 'TRADING', label: 'Order missing', team: 'TRADING_OPERATIONS' },
  { key: 'TRADING.FILL', parentKey: 'TRADING', label: 'Fill disagreement', team: 'TRADING_OPERATIONS' },
  { key: 'TRADING.POSITION', parentKey: 'TRADING', label: 'Position disagreement', team: 'TRADING_OPERATIONS' },
  { key: 'TRADING.PNL', parentKey: 'TRADING', label: 'P&L disagreement', team: 'TRADING_OPERATIONS' },
  { key: 'TRADING.UNAVAILABLE', parentKey: 'TRADING', label: 'Platform unavailable', team: 'TECHNICAL_OPERATIONS', defaultPriority: 'HIGH' },
  { key: 'PAYOUT', label: 'Payout', team: 'PAYOUT_OPERATIONS' },
  { key: 'PAYOUT.ELIGIBILITY', parentKey: 'PAYOUT', label: 'Eligibility', team: 'PAYOUT_OPERATIONS' },
  { key: 'PAYOUT.AMOUNT', parentKey: 'PAYOUT', label: 'Amount', team: 'PAYOUT_OPERATIONS' },
  { key: 'PAYOUT.PROCESSING', parentKey: 'PAYOUT', label: 'Processing', team: 'PAYOUT_OPERATIONS' },
  { key: 'PAYOUT.FAILED', parentKey: 'PAYOUT', label: 'Failed / returned', team: 'PAYOUT_OPERATIONS' },
  { key: 'PAYOUT.DESTINATION', parentKey: 'PAYOUT', label: 'Destination', team: 'PAYOUT_OPERATIONS' },
  { key: 'PAYOUT.MISSING', parentKey: 'PAYOUT', label: 'Missing payment', team: 'PAYOUT_OPERATIONS' },
  { key: 'BILLING', label: 'Purchase / Billing', team: 'BILLING' },
  { key: 'BILLING.DUPLICATE', parentKey: 'BILLING', label: 'Duplicate charge', team: 'BILLING', defaultPriority: 'HIGH' },
  { key: 'BILLING.FAILED', parentKey: 'BILLING', label: 'Failed purchase', team: 'BILLING' },
  { key: 'BILLING.REFUND', parentKey: 'BILLING', label: 'Refund', team: 'BILLING' },
  { key: 'BILLING.CHARGEBACK', parentKey: 'BILLING', label: 'Chargeback question', team: 'BILLING' },
  { key: 'RESET', label: 'Reset', team: 'GENERAL_SUPPORT' },
  { key: 'LOGIN', label: 'Login / Security', team: 'TECHNICAL_OPERATIONS', defaultPriority: 'HIGH' },
  { key: 'IDENTITY', label: 'Identity / Verification', team: 'GENERAL_SUPPORT' },
  { key: 'RULE_QUESTION', label: 'Rule question', team: 'GENERAL_SUPPORT' },
  { key: 'ACCOUNT_FAILURE', label: 'Account failure / breach', team: 'RISK_ENFORCEMENT' },
  { key: 'CERTIFICATE', label: 'Certificate / Achievement', team: 'GENERAL_SUPPORT' },
  { key: 'AFFILIATE', label: 'Affiliate', team: 'AFFILIATES' },
  { key: 'AFFILIATE.APPLICATION', parentKey: 'AFFILIATE', label: 'Application', team: 'AFFILIATES' },
  { key: 'AFFILIATE.AGREEMENT', parentKey: 'AFFILIATE', label: 'Agreement', team: 'AFFILIATES' },
  { key: 'AFFILIATE.ATTRIBUTION', parentKey: 'AFFILIATE', label: 'Attribution', team: 'AFFILIATES' },
  { key: 'AFFILIATE.COMMISSION', parentKey: 'AFFILIATE', label: 'Commission', team: 'AFFILIATES' },
  { key: 'AFFILIATE.TIER', parentKey: 'AFFILIATE', label: 'Tier', team: 'AFFILIATES' },
  { key: 'AFFILIATE.PAYOUT', parentKey: 'AFFILIATE', label: 'Payout', team: 'AFFILIATES' },
  { key: 'AFFILIATE.CODE', parentKey: 'AFFILIATE', label: 'Code / link', team: 'AFFILIATES' },
  { key: 'TECHNICAL', label: 'Technical / Platform', team: 'TECHNICAL_OPERATIONS' },
  { key: 'REFUND', label: 'Refund', team: 'BILLING' },
  { key: 'ENFORCEMENT', label: 'Enforcement / Review', team: 'RISK_ENFORCEMENT' },
  { key: 'OTHER', label: 'Other', team: 'GENERAL_SUPPORT' },
];

// ---------------------------------------------------------------------------
// Program settings (versioned) + default SLA
// ---------------------------------------------------------------------------
export interface SupportSettings {
  readonly reopenWindowDays: number;
  readonly maxAttachmentBytes: number;
  readonly allowedAttachmentTypes: string[];
  readonly maxAttachmentsPerMessage: number;
  readonly ticketRateLimitPerHour: number;
  readonly duplicateWindowMinutes: number;
  readonly csatEnabled: boolean;
  readonly teams: string[];
  readonly defaultSlaPolicyKey: string;
  readonly notifyCustomerOnStaffReply: boolean;
}

export const DEFAULT_SUPPORT_SETTINGS: SupportSettings = {
  reopenWindowDays: 14,
  maxAttachmentBytes: 10 * 1024 * 1024, // 10 MB
  allowedAttachmentTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'],
  maxAttachmentsPerMessage: 5,
  ticketRateLimitPerHour: 10,
  duplicateWindowMinutes: 60,
  csatEnabled: true,
  teams: [...SUPPORT_TEAMS],
  defaultSlaPolicyKey: 'STANDARD',
  notifyCustomerOnStaffReply: true,
};

/** Default SLA targets in MINUTES, by priority. Business hours are configurable. */
export const DEFAULT_SLA = {
  key: 'STANDARD',
  name: 'Standard support',
  firstResponseMinsByPriority: { URGENT: 60, HIGH: 240, NORMAL: 1440, LOW: 2880 } as Record<Priority, number>,
  resolutionMinsByPriority: { URGENT: 480, HIGH: 1440, NORMAL: 4320, LOW: 10080 } as Record<Priority, number>,
  pauseOnWaiting: true,
  businessHours: { timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', observeHours: false },
};

export interface SupportConfigResult { readonly version: number; readonly settings: SupportSettings }

/** Read the current config, seeding v1 + default categories + default SLA on first use. */
export async function getSupportConfig(db: Database, organizationId: string): Promise<SupportConfigResult> {
  const [row] = await db.select().from(supportConfig).where(eq(supportConfig.organizationId, organizationId)).orderBy(desc(supportConfig.version)).limit(1);
  if (row) return { version: row.version, settings: { ...DEFAULT_SUPPORT_SETTINGS, ...(row.settings as Partial<SupportSettings>) } };
  await db.insert(supportConfig).values({ organizationId, version: 1, settings: DEFAULT_SUPPORT_SETTINGS as never }).onConflictDoNothing();
  await seedSupportDefaults(db, organizationId);
  const [seeded] = await db.select().from(supportConfig).where(eq(supportConfig.organizationId, organizationId)).orderBy(desc(supportConfig.version)).limit(1);
  return { version: seeded?.version ?? 1, settings: { ...DEFAULT_SUPPORT_SETTINGS, ...((seeded?.settings as Partial<SupportSettings>) ?? {}) } };
}

/** Append a new config version, merging over the current settings. */
export async function updateSupportConfig(db: Database, organizationId: string, patch: Partial<SupportSettings>, actor: Actor): Promise<SupportConfigResult> {
  const current = await getSupportConfig(db, organizationId);
  const next: SupportSettings = { ...current.settings, ...patch };
  const version = current.version + 1;
  await db.insert(supportConfig).values({ organizationId, version, settings: next as never, updatedByUserId: actor.userId ?? null });
  await recordAudit(db, { organizationId, actor, subjectType: 'SUPPORT_TICKET', subjectId: null, action: 'support.config.updated', prevState: { version: current.version }, newState: { version }, reason: 'support config updated' });
  return { version, settings: next };
}

/** Seed the default category tree + the default SLA policy (idempotent). */
export async function seedSupportDefaults(db: Database, organizationId: string): Promise<void> {
  for (const c of DEFAULT_CATEGORIES) {
    await db.insert(supportCategories).values({
      organizationId, key: c.key, parentKey: c.parentKey ?? null, label: c.label,
      team: c.team ?? null, defaultPriority: c.defaultPriority ?? 'NORMAL',
    }).onConflictDoNothing();
  }
  await db.insert(supportSlaPolicies).values({
    organizationId, key: DEFAULT_SLA.key, name: DEFAULT_SLA.name,
    firstResponseMinsByPriority: DEFAULT_SLA.firstResponseMinsByPriority as never,
    resolutionMinsByPriority: DEFAULT_SLA.resolutionMinsByPriority as never,
    pauseOnWaiting: DEFAULT_SLA.pauseOnWaiting, businessHours: DEFAULT_SLA.businessHours as never,
  }).onConflictDoNothing();
}

export async function listCategories(db: Database, organizationId: string) {
  await getSupportConfig(db, organizationId); // ensure seeded
  return db.select().from(supportCategories).where(and(eq(supportCategories.organizationId, organizationId), eq(supportCategories.active, true))).orderBy(supportCategories.sortOrder, supportCategories.key);
}

export async function slaPolicy(db: Database, organizationId: string, key: string) {
  const [p] = await db.select().from(supportSlaPolicies).where(and(eq(supportSlaPolicies.organizationId, organizationId), eq(supportSlaPolicies.key, key)));
  return p ?? null;
}

// ---------------------------------------------------------------------------
// Public references + priority suggestion
// ---------------------------------------------------------------------------
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
/** A human-readable, non-sequential public reference, e.g. HT-7QK4M2. */
export function generateTicketRef(): string {
  let s = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return `HT-${s}`;
}
export function generateRemediationRef(): string {
  let s = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) s += REF_ALPHABET[b % REF_ALPHABET.length];
  return `REM-${s}`;
}

/**
 * A deterministic, conservative suggested priority from the category and the
 * customer's stated urgency. It NEVER escalates on tone; only category + concrete
 * signals raise it, and the authoritative priority is always staff-settable.
 */
export function suggestPriority(categoryKey: string, defaultPriority: Priority, signals: { fundedAccountAffected?: boolean; tradingBroken?: boolean; payoutUnknown?: boolean; duplicateCharge?: boolean; securityConcern?: boolean } = {}): Priority {
  const order: Priority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
  let level = order.indexOf(defaultPriority);
  const raise = (to: Priority) => { level = Math.max(level, order.indexOf(to)); };
  if (categoryKey.startsWith('LOGIN') || signals.securityConcern) raise('HIGH');
  if (signals.tradingBroken) raise('HIGH');
  if (signals.duplicateCharge) raise('HIGH');
  if (signals.payoutUnknown) raise('HIGH');
  if (signals.fundedAccountAffected && (signals.tradingBroken || signals.payoutUnknown)) raise('URGENT');
  return order[level] ?? 'NORMAL';
}
