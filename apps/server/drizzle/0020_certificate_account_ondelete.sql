-- A certificate is earned recognition and must outlive an account row's removal.
-- Change certificates.account_id from the default NO ACTION to ON DELETE SET NULL
-- so deleting an account nulls the reference rather than being blocked.
ALTER TABLE "certificates" DROP CONSTRAINT IF EXISTS "certificates_account_id_fkey";
--> statement-breakpoint
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL;
