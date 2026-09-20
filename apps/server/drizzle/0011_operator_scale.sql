-- Keep the operator console flat as a firm grows.
--
-- Measured at 10,000 traders, the traders and accounts lists order by
-- created_at with only an organisation index, and search runs ilike as a
-- sequential scan. Both grow linearly with the firm. These indexes make the
-- list ordering a keyset walk and the search a trigram lookup, so page one and
-- a name search cost the same at 100k as at 100.

-- Composite indexes matching the list's own (organization_id, created_at desc)
-- ordering: the exact shape keyset pagination pages through.
CREATE INDEX IF NOT EXISTS "users_org_created_idx"
  ON "users" ("organization_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "accounts_org_created_idx"
  ON "accounts" ("organization_id", "created_at" DESC);

-- Trigram search: an operator finds a trader by typing part of an email or
-- name, and an account by part of its number. Without this that is a table
-- scan; with it, an index lookup.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "users_email_trgm" ON "users" USING gin ("email" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_display_name_trgm" ON "users" USING gin ("display_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "accounts_public_id_trgm" ON "accounts" USING gin ("public_id" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "accounts_name_trgm" ON "accounts" USING gin ("name" gin_trgm_ops);
