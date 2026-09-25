/*
 * Happy Trader Funding — public product catalog for the marketing site.
 *
 * The data now lives in the shared, authoritative catalog in @atlas/contracts
 * (`product-catalog.ts`), so the public site, the server DB seed and the economics
 * engine all read the same prices and payout parameters from ONE place. This module
 * re-exports the marketing-facing view unchanged, so every existing import
 * (`FAMILIES`, `ALL_ACCOUNTS`, `usd`, `price`, `sizeLabel`, `family`, and the types)
 * keeps working exactly as before.
 */
export {
  FAMILIES,
  ALL_ACCOUNTS,
  family,
  usd,
  price,
  sizeLabel,
  type FamilyKey,
  type AccountConfig,
  type Family,
} from '@atlas/contracts';
