-- Portal V2 Experience Layer Phase 2 — celebration acknowledgements.
--
-- PRESENTATION SUPPORT ONLY: a per-customer "has seen this milestone celebration"
-- flag so a major moment (funded, first payout, club reached, account completed) is
-- celebrated ONCE, not on every refresh. Owner-scoped by customer_identity_id; the
-- event_key is the stable `achievement:<id>` of an exactly-once authoritative
-- achievement. No business truth is stored here. Unique on (identity, event_key)
-- makes acknowledgement idempotent.

CREATE TABLE IF NOT EXISTS "celebration_acks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "customer_identity_id" uuid NOT NULL REFERENCES "customer_identities"("id") ON DELETE CASCADE,
  "event_key" varchar(80) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "celebration_acks_identity_event_key" ON "celebration_acks" ("customer_identity_id","event_key");
