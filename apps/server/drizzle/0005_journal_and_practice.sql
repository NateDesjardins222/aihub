-- Milestone 5: the training environment.
--
-- Three things are added: what a trade FELT like while it was open (MAE/MFE and
-- the risk it was taken with), the practice session a trade belongs to, and the
-- trader's own words about both.

-- How far a trade went against and for the trader before it closed. Recorded by
-- the engine from genuine marks; nothing here is reconstructed afterwards.
ALTER TABLE "trades" ADD COLUMN "mae_micros" bigint NOT NULL DEFAULT 0;
ALTER TABLE "trades" ADD COLUMN "mfe_micros" bigint NOT NULL DEFAULT 0;
-- What the trade risked when it was opened: the distance to its protective stop.
-- Null when it was taken without one, which is what makes R undefined.
ALTER TABLE "trades" ADD COLUMN "initial_risk_micros" bigint;
ALTER TABLE "trades" ADD COLUMN "session_id" uuid;
ALTER TABLE "trades" ADD COLUMN "notes" text;

-- The running extremes of the OPEN position, which the closed lots inherit.
ALTER TABLE "positions" ADD COLUMN "mae_micros" bigint NOT NULL DEFAULT 0;
ALTER TABLE "positions" ADD COLUMN "mfe_micros" bigint NOT NULL DEFAULT 0;
ALTER TABLE "positions" ADD COLUMN "initial_risk_micros" bigint;

CREATE TABLE IF NOT EXISTS "practice_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- LIVE or REPLAY, and which training mode the trader chose.
  "source" varchar(12) NOT NULL DEFAULT 'REPLAY',
  "mode" varchar(24) NOT NULL DEFAULT 'STANDARD',
  -- What the trader could see, and how the replay was configured.
  "config" jsonb,
  "recording_id" varchar(120),
  "symbol" varchar(12),
  "trading_date" date,
  -- A blind session hides its date until it ends.
  "date_hidden" boolean NOT NULL DEFAULT false,
  "starting_balance_micros" bigint NOT NULL,
  "ending_balance_micros" bigint,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  -- The review. Written once at the end and never recomputed, so a session's
  -- record cannot drift as later trades arrive.
  "summary" jsonb,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "practice_sessions_account_idx"
  ON "practice_sessions" ("account_id", "started_at");

-- Tags are the trader's vocabulary, not ours: every one of them is a row they
-- created. The seed ships a starting set and they are free to delete all of it.
CREATE TABLE IF NOT EXISTS "trade_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" varchar(40) NOT NULL,
  "color" varchar(16) NOT NULL DEFAULT 'slate',
  -- Whether a tag means the trade went well, badly, or neither.
  "kind" varchar(12) NOT NULL DEFAULT 'NEUTRAL',
  "sort" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "trade_tags_user_name_key" UNIQUE ("user_id", "name")
);

CREATE TABLE IF NOT EXISTS "trade_tag_links" (
  "trade_id" uuid NOT NULL REFERENCES "trades"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "trade_tags"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "trade_tag_links_key" PRIMARY KEY ("trade_id", "tag_id")
);

CREATE TABLE IF NOT EXISTS "session_tag_links" (
  "session_id" uuid NOT NULL REFERENCES "practice_sessions"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL REFERENCES "trade_tags"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_tag_links_key" PRIMARY KEY ("session_id", "tag_id")
);

-- Where a trader's preferences live between sessions: chart motion, replay
-- behaviour, what is visible, and which training mode they were last in.
CREATE TABLE IF NOT EXISTS "user_preferences" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
