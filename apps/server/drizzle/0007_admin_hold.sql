-- An operator's hold, kept apart from the rule engine's status.
--
-- The two answer different questions. A day-lockout the rules imposed expires
-- by itself when the next trading date arrives; an administrator's lock does
-- not, and before this the next mark simply re-evaluated the account and put
-- it back to ACTIVE - quietly undoing the operator's decision.

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "admin_hold" varchar(20);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "rule_status" varchar(20) DEFAULT 'ACTIVE' NOT NULL;

-- The rule status is whatever the account already had, when that is something
-- the rule engine could have produced.
UPDATE "accounts"
SET "rule_status" = CASE
  WHEN "status" IN ('ACTIVE', 'GOAL_REACHED', 'LOCKED', 'PASSED', 'FAILED') THEN "status"
  ELSE 'ACTIVE'
END;

-- Anything else it had was administrative, so that is what it becomes.
UPDATE "accounts"
SET "admin_hold" = "status"
WHERE "status" IN ('PENDING', 'DISABLED', 'ARCHIVED');

CREATE INDEX IF NOT EXISTS "accounts_admin_hold_idx" ON "accounts" ("admin_hold");
