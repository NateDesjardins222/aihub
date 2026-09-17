-- Which market a position was opened against.
--
-- Market data is global; accounts are not. Starting a practice replay swapped
-- the whole platform's data source, and every open position - including ones
-- opened minutes earlier against the live feed - was silently re-marked at the
-- recording's prices. A position opened at 29,763 was marked at 29,467 and
-- reported a $5,920 loss it had not made; with an older recording the same
-- mechanism produced tens of thousands of dollars, and any mark ABOVE the
-- entry was committed into the account's high-water mark and drawdown floor,
-- which is permanent damage rather than a display error.
--
-- A position now remembers the era it was opened in, and a mark from a
-- different era does not apply to it: its P&L reads as unknown rather than as
-- a number nobody can reconcile.
alter table "positions" add column if not exists "market_era" varchar(80);

comment on column "positions"."market_era" is
  'Market-data source the opening fill was priced against, e.g. live:yahoo-delayed or replay:<recording>. Null for positions opened before this column existed.';
