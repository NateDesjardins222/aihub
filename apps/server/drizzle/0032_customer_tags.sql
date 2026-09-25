-- M10-D: internal customer tags / segmentation.
CREATE TABLE IF NOT EXISTS "customer_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tag" varchar(40) NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "customer_tags_user_tag_key" ON "customer_tags" ("user_id","tag");
CREATE INDEX IF NOT EXISTS "customer_tags_tag_idx" ON "customer_tags" ("tag");
