-- Budget months: the data Odoo does not hold.
--
-- One row per month. `doc` is the whole budget document — plans, the working-day
-- calendar, the daily Zipper / Metal Trims figures fetched from Odoo, and the
-- source mapping. Keeping it as one JSON document means the shape can change
-- without a migration, and a month is always written atomically.

create table if not exists public.budget_months (
  month       text primary key check (month ~ '^\d{4}-\d{2}$'),
  doc         jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists budget_months_updated_at_idx
  on public.budget_months (updated_at desc);

-- Only this site's server touches the table, and it uses the service-role key,
-- which bypasses RLS. RLS is on with no policies, so the anon key — the one that
-- would ever reach a browser — can read nothing.
alter table public.budget_months enable row level security;

comment on table public.budget_months is
  'Monthly budget vs achievement documents for the manufacturing report site.';


-- Cached aggregates that are expensive to rebuild — currently the monthly
-- packing roll-ups behind the ABC analytics. Values are derived from Odoo and
-- can be dropped at any time; the app refetches what is missing.
create table if not exists public.app_cache (
  key         text primary key,
  doc         jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.app_cache enable row level security;

comment on table public.app_cache is
  'Derived aggregates cached from Odoo. Safe to truncate.';
