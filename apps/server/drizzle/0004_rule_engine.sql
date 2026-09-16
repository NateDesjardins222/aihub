-- The prop-firm rule engine needs somewhere to keep its state.
--
-- Everything here is per account or per programme, because rules are data: a
-- 50K evaluation, a funded account and a practice account differ only in these
-- values, never in engine code.
ALTER TABLE "rule_templates" ADD COLUMN "min_winning_days" integer NOT NULL DEFAULT 0;
ALTER TABLE "rule_templates" ADD COLUMN "min_winning_day_pnl_micros" bigint NOT NULL DEFAULT 1;
-- LOCK_DAY: the day ends, the account survives. FAIL: the programme is over.
ALTER TABLE "rule_templates" ADD COLUMN "daily_loss_policy" varchar(12) NOT NULL DEFAULT 'LOCK_DAY';
ALTER TABLE "rule_templates" ADD COLUMN "flatten_on_breach" boolean NOT NULL DEFAULT true;

ALTER TABLE "accounts" ADD COLUMN "winning_days_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "accounts" ADD COLUMN "best_day_profit_micros" bigint NOT NULL DEFAULT 0;
-- The trading date a day-lockout ends on, exclusive. Null when not locked.
ALTER TABLE "accounts" ADD COLUMN "locked_until_date" date;
-- Per-account overrides of the programme's rules, so one trader can be moved
-- onto different terms without creating a whole template.
ALTER TABLE "accounts" ADD COLUMN "rule_overrides" jsonb;
