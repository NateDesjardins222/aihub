/**
 * The provisioning gate — the single, read-only predicate the commerce funnel
 * consults before it turns a paid order into an evaluation account.
 *
 * It NEVER provisions and has NO side effects. It answers three questions from
 * the customer-identity domain:
 *   - identityOk: identity_status === IDENTITY_VERIFIED
 *   - contactOk:  a primary email AND phone are VERIFIED (live, not the coarse status)
 *   - agreementsOk: every required agreement's current version is accepted
 *
 * This is the ONLY coupling between customer identity and the commerce/trading
 * authority. See docs/customer-identity-v1.md §9 and docs/commerce-provisioning-v1.md.
 */
import type { Database } from '../db/client.js';
import { ensureCustomerIdentity, getIdentityByUser } from './customer-identity.js';
import { primaryContactsVerified } from './contact-verification.js';
import { outstandingAgreements } from './agreements.js';

export interface ProvisioningGate {
  readonly customerIdentityId: string;
  readonly identityOk: boolean;
  readonly contactOk: boolean;
  readonly agreementsOk: boolean;
  readonly satisfied: boolean;
  readonly blockedReasons: string[];
}

/**
 * Evaluate the gate for an authenticated user in an org. Ensures the customer
 * identity exists (idempotent) so a first-time buyer is never blocked merely for
 * lacking a spine row.
 */
export async function evaluateProvisioningGate(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<ProvisioningGate> {
  const identity =
    (await getIdentityByUser(db, organizationId, userId)) ??
    (await ensureCustomerIdentity(db, { organizationId, userId }));

  const identityOk = identity.identityStatus === 'IDENTITY_VERIFIED';
  const contacts = await primaryContactsVerified(db, identity.id);
  const contactOk = contacts.email && contacts.sms;
  const outstanding = await outstandingAgreements(db, organizationId, identity.id);
  const agreementsOk = outstanding.length === 0;

  const blockedReasons: string[] = [];
  if (!contactOk) {
    if (!contacts.email) blockedReasons.push('CONTACT_EMAIL_UNVERIFIED');
    if (!contacts.sms) blockedReasons.push('CONTACT_PHONE_UNVERIFIED');
  }
  if (!identityOk) blockedReasons.push(`IDENTITY_${identity.identityStatus}`);
  for (const a of outstanding) blockedReasons.push(`AGREEMENT_MISSING:${a.agreementType}`);

  return {
    customerIdentityId: identity.id,
    identityOk,
    contactOk,
    agreementsOk,
    satisfied: identityOk && contactOk && agreementsOk,
    blockedReasons,
  };
}
