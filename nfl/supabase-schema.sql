-- Gridiron Pride (NFL draft pool) — one-time setup.
-- Run this once in the Supabase SQL editor for the same project the World
-- Cup app uses (kqwitbmocklwsmjcuxoy). It creates a separate, nfl_-prefixed
-- set of tables so this app never touches the World Cup app's data.

create table if not exists nfl_managers (
  id bigint generated always as identity primary key,
  name text not null,
  slug text not null,
  draft_position int not null
);

create table if not exists nfl_picks (
  id bigint generated always as identity primary key,
  manager_id bigint not null references nfl_managers(id) on delete cascade,
  team_id text not null,
  pick_number int not null
);

create table if not exists nfl_draft_state (
  id int primary key,
  current_pick int not null default 1,
  draft_started boolean not null default false,
  draft_complete boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into nfl_draft_state (id, current_pick, draft_started, draft_complete)
values (1, 1, false, false)
on conflict (id) do nothing;

create table if not exists nfl_team_scores (
  team_id text primary key,
  wins int not null default 0,
  losses int not null default 0,
  ties int not null default 0,
  points numeric not null default 0,
  updated_at timestamptz not null default now()
);

alter table nfl_managers enable row level security;
alter table nfl_picks enable row level security;
alter table nfl_draft_state enable row level security;
alter table nfl_team_scores enable row level security;

-- Open policies: like the World Cup app, there's no login system — anyone
-- holding the anon key (baked into the static page) can read/write. That's
-- an intentional trust model for a small private friend-group app, not an
-- oversight. Drop/tighten these if that ever stops being true.
create policy "public read nfl_managers"   on nfl_managers   for select using (true);
create policy "public insert nfl_managers" on nfl_managers   for insert with check (true);
create policy "public update nfl_managers" on nfl_managers   for update using (true);
create policy "public delete nfl_managers" on nfl_managers   for delete using (true);

create policy "public read nfl_picks"      on nfl_picks      for select using (true);
create policy "public insert nfl_picks"    on nfl_picks      for insert with check (true);
create policy "public update nfl_picks"    on nfl_picks      for update using (true);
create policy "public delete nfl_picks"    on nfl_picks      for delete using (true);

create policy "public read nfl_draft_state"   on nfl_draft_state for select using (true);
create policy "public insert nfl_draft_state" on nfl_draft_state for insert with check (true);
create policy "public update nfl_draft_state" on nfl_draft_state for update using (true);

create policy "public read nfl_team_scores"   on nfl_team_scores for select using (true);
create policy "public insert nfl_team_scores" on nfl_team_scores for insert with check (true);
create policy "public update nfl_team_scores" on nfl_team_scores for update using (true);
