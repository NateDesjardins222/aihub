-- The open-position contract lock: a position records its actual contract.
--
-- Orders, executions and trades already carry contract_code (migration 0012);
-- positions did not, so a position was identified only by (account, root) and
-- its market era. When the continuous/front contract rolls, a root-keyed live
-- feed would begin marking an open position with the NEXT contract's prices.
--
-- This column stamps the specific tradeable contract a position was opened in
-- (e.g. NQZ26). It is written at open and never silently rewritten to a later
-- front month; the engine marks a position only by its own contract's prices,
-- so a roll can never silently move an open position. Nullable and additive:
-- rows written before this, and any root that cannot be resolved, stay NULL,
-- which means "root only" - never a wrong contract. No back-fill: an existing
-- open position keeps NULL and is marked as before (era protection still
-- applies), because inventing a historical contract that cannot be proven would
-- be its own defect.

ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "contract_code" varchar(24);

-- Query open exposure by the actual contract, not only the root.
CREATE INDEX IF NOT EXISTS "positions_contract_idx" ON "positions" ("account_id", "contract_code");
