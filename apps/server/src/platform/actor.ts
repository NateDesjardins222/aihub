/**
 * Who did a thing.
 *
 * Every audited action carries one of these. It is captured at the call site
 * rather than inferred later, because "the admin who locked this account" is
 * not recoverable from the row it changed.
 */
export interface Actor {
  readonly type: 'USER' | 'ADMIN' | 'SYSTEM' | 'SERVICE';
  readonly userId?: string | null;
  /** A readable label frozen at write time: an e-mail, a key name, `system`. */
  readonly label?: string | null;
  readonly ip?: string | null;
  readonly requestId?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', label: 'system' };
