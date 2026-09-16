-- A closed bar may only fill an order that already existed when it opened.
--
-- The engine fills resting orders from a bar's extremes, because on a delayed
-- feed those are the only prices it can prove traded. Without knowing WHEN an
-- order started resting, an order placed at 10:04 could fill from the 10:03
-- bar's low - a price that traded before the order was sent. This records the
-- exchange time at which each order started resting, so the matcher can refuse
-- any bar that opened before it.
ALTER TABLE "orders" ADD COLUMN "rested_market_ts" bigint;
