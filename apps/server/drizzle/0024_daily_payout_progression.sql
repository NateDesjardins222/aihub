-- Milestone 6 — Daily payout progressive qualifying-balance rule.
-- Additive and safe: one new nullable column, no back-fill, no destructive change.
-- Snapshots the authoritative qualifying account balance (pre-debit) at the
-- exactly-once payout approval boundary, so each successive DAILY payout can be
-- required to qualify STRICTLY above the previous one's balance.

ALTER TABLE "payout_requests"
  ADD COLUMN IF NOT EXISTS "qualifying_balance_at_approval" bigint;
