-- Contract identity survives persistence.
--
-- Every execution-bearing row stored only the ROOT ("NQ"), so an NQZ26 fill and
-- an NQH27 fill were indistinguishable once written. These columns record the
-- specific tradable contract an order intended and a fill/trade happened in,
-- resolved from the exchange listing cycle at the time. Nullable: rows written
-- before contract identity, and any root that cannot be resolved, keep NULL,
-- which means "root only" - never a wrong contract.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "contract_code" varchar(24);
ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "contract_code" varchar(24);
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "contract_code" varchar(24);

-- Query fills and trades by the actual contract, not only the root.
CREATE INDEX IF NOT EXISTS "executions_contract_idx" ON "executions" ("account_id", "contract_code");
CREATE INDEX IF NOT EXISTS "trades_contract_idx" ON "trades" ("account_id", "contract_code");
