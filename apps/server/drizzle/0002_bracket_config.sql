-- A bracket's intent must outlive the submission that requested it.
--
-- Entries do not fill instantly: simulated latency, a resting limit, or an
-- unreachable price all mean the fill arrives on a later market event. The
-- protective legs are created when the entry actually fills, so the offsets
-- have to be stored with the order rather than held in the request handler.
ALTER TABLE "orders" ADD COLUMN "bracket_config" jsonb;
