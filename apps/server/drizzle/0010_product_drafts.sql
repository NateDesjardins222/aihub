-- A working draft of a product's terms, before it becomes a version.
--
-- A published version is immutable (see the trigger in 0006); a draft is where
-- an operator composes and revises an edit until it is right. Publishing a
-- draft writes version N+1 and deletes the draft. At most one draft per product
-- key per firm, so two operators editing the same product share one work in
-- progress instead of clobbering each other.

CREATE TABLE IF NOT EXISTS "account_profile_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations" ("id"),
  "profile_id" uuid REFERENCES "account_profiles" ("id") ON DELETE CASCADE,
  "key" varchar(60) NOT NULL,
  "name" varchar(120) NOT NULL,
  "account_type" varchar(20) NOT NULL,
  "description" text,
  "config" jsonb NOT NULL,
  "notes" text,
  "base_version" integer,
  "updated_by_user_id" uuid REFERENCES "users" ("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_profile_drafts_org_key"
  ON "account_profile_drafts" ("organization_id", "key");
