-- Atlas Native Copy Trading V1 — copy groups, followers, intents, children.
-- Orchestration metadata only; no money lives here.

CREATE TABLE IF NOT EXISTS "copy_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" varchar(80) NOT NULL,
  "leader_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "sizing_mode" varchar(16) NOT NULL DEFAULT 'SAME',
  "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "version" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_groups_identity_idx" ON "copy_groups" ("customer_identity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_groups_user_idx" ON "copy_groups" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_groups_leader_idx" ON "copy_groups" ("leader_account_id");
--> statement-breakpoint
-- An account leads at most one non-disabled group (loop / chain prevention).
CREATE UNIQUE INDEX IF NOT EXISTS "copy_groups_active_leader_key" ON "copy_groups" ("leader_account_id")
  WHERE status <> 'DISABLED' AND leader_account_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "copy_followers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "copy_group_id" uuid NOT NULL REFERENCES "copy_groups"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT true,
  "sizing_multiplier_milli" integer,
  "sizing_fixed_qty" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copy_followers_group_account_key" ON "copy_followers" ("copy_group_id", "account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_followers_account_idx" ON "copy_followers" ("account_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "copy_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "copy_group_id" uuid NOT NULL REFERENCES "copy_groups"("id") ON DELETE CASCADE,
  "leader_account_id" uuid NOT NULL,
  "kind" varchar(12) NOT NULL,
  "idempotency_key" varchar(120) NOT NULL,
  "symbol" varchar(12),
  "side" varchar(4),
  "qty" integer,
  "order_type" varchar(16),
  "limit_ticks" integer,
  "stop_ticks" integer,
  "bracket_config" jsonb,
  "leader_order_id" uuid,
  "state" varchar(16) NOT NULL DEFAULT 'PENDING',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copy_intents_group_idem_key" ON "copy_intents" ("copy_group_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_intents_group_idx" ON "copy_intents" ("copy_group_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "copy_children" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "copy_intent_id" uuid NOT NULL REFERENCES "copy_intents"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "role" varchar(8) NOT NULL,
  "requested_qty" integer NOT NULL DEFAULT 0,
  "sizing_note" varchar(200),
  "status" varchar(12) NOT NULL DEFAULT 'PENDING',
  "order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "reject_code" varchar(48),
  "reject_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "copy_children_intent_account_key" ON "copy_children" ("copy_intent_id", "account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_children_account_idx" ON "copy_children" ("account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copy_children_order_idx" ON "copy_children" ("order_id");
