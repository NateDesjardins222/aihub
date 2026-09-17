-- Drawings get storage of their own.
--
-- They used to live inside the single preferences blob, which is capped at
-- 64 KB because it holds a handful of display choices. A busy chart passes
-- that on its own - two hundred and fifty objects is about 85 KB - and when it
-- did, the whole save failed: the motion settings, the training mode and the
-- indicators went with the drawings. Their own table, with a limit that suits
-- what it holds, keeps one trader's habit of drawing a lot from costing them
-- everything else.
create table if not exists "user_drawings" (
  "user_id" uuid primary key references "users"("id") on delete cascade,
  "drawings" jsonb not null default '[]'::jsonb,
  "updated_at" timestamptz not null default now()
);
