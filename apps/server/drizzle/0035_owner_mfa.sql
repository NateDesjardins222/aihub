-- Phase 12.5 — Owner/operator MFA (TOTP) + single-use recovery codes.
-- The TOTP shared secret is stored ENCRYPTED at rest (AES-256-GCM, key derived
-- from JWT_SECRET); recovery codes are stored only as SHA-256 hashes and are
-- consumed by an UPDATE that sets used_at, so a code cannot be replayed.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enrolled_at" timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mfa_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mfa_recovery_codes_hash_key" ON "mfa_recovery_codes" ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mfa_recovery_codes_user_idx" ON "mfa_recovery_codes" ("user_id");
