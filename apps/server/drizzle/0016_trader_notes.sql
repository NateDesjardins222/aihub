-- Owner Control Center V3: internal staff notes about a trader.
--
-- Owner-side operational data; a trader never sees it. Append-only: a note is
-- written once and superseded or redacted, never silently overwritten. Every
-- write is also audited through the ordinary recorder. Additive and safe.

CREATE TABLE IF NOT EXISTS "trader_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "subject_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category" varchar(16) NOT NULL DEFAULT 'GENERAL',
  "body" text NOT NULL,
  "author_user_id" uuid REFERENCES "users"("id"),
  "author_label" varchar(120),
  "redacted_at" timestamptz,
  "redacted_by_label" varchar(120),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "trader_notes_subject_idx" ON "trader_notes" ("subject_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "trader_notes_org_idx" ON "trader_notes" ("organization_id", "created_at");
