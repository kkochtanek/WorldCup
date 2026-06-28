-- Budget League storage for the "💰 Budget" tab.
-- One-time setup: paste this into the Supabase SQL editor and run it.
--
-- The app writes with the public anon key (same as managers/picks/team_scores),
-- so this mirrors that access pattern. manager_id is the PRIMARY KEY, which lets
-- the app's upsert (POST + resolution=merge-duplicates) overwrite a manager's
-- roster on every save instead of inserting duplicates.

create table if not exists public.budget_rosters (
  manager_id  bigint primary key references public.managers(id) on delete cascade,
  teams       jsonb       not null default '[]'::jsonb,   -- array of team ids, e.g. ["ENG","GER","CPV",...]
  spend       integer     not null default 0,
  updated_at  timestamptz not null default now()
);

alter table public.budget_rosters enable row level security;

-- Permissive policy so the shared anon key can read and write rosters,
-- matching how the rest of this league's tables are accessed.
drop policy if exists "anon manages budget_rosters" on public.budget_rosters;
create policy "anon manages budget_rosters"
  on public.budget_rosters
  for all
  to anon
  using (true)
  with check (true);
