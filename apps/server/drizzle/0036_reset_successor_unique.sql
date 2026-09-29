-- Resilience Phase 2 (RES-4) — DB-level defense-in-depth for the reset invariant.
--
-- "At most one reset successor per failed account" is enforced in the application
-- by the fixed `reset:<failedAccountId>` order idempotency key (+ FOR UPDATE and
-- the `ent:<id>` provisioning key), proven under 8-way concurrency. This adds the
-- last line of defence at the database: a partial UNIQUE index so a second, racing
-- successor for the same failed account fails closed on the index rather than ever
-- being created. It is partial (WHERE reset_of_account_id IS NOT NULL) so it
-- applies only to reset successors and never constrains ordinary accounts. Idempotent
-- (IF NOT EXISTS); safe to run on a fresh DB and as an upgrade. No existing data
-- violates it (the invariant already held), so creation cannot fail on current data.
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_reset_of_key"
  ON "accounts" ("reset_of_account_id")
  WHERE "reset_of_account_id" IS NOT NULL;
