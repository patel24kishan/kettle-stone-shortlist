-- Kettle & Stone waitlist shortlist: the Supabase database (feature 6e, build-plan section 4).
--
-- How to use: open the Supabase project, go to SQL Editor, paste this whole file and press Run.
-- It is safe to run again: every part checks whether it already exists, and nothing here deletes data.
--
-- What lives here (Supabase is the one place the tool's state lives):
--   imports         every "Import and analyse" (the three CSV files exactly as imported, never edited)
--   reading_cache   Claude's readings of the notes, keyed by a hash of each person's lines
--   booked          who filled which opening (one row per opening, one live row per person)
--   booked_history  bookings that were undone, kept for the record ("nothing is deleted")
--   app_state       one row with a version number that goes up on every change, so open screens refresh
--
-- Who can read what:
--   The app's server uses the service-role key, which bypasses row level security, for every read and write.
--   Logged-in staff browsers (the "authenticated" role) may only read app_state, so they can listen for changes
--   through Supabase Realtime. They cannot read or change anything else directly: no names, phones or notes
--   ever reach the browser from the database. Anonymous visitors ("anon") can read nothing.

-- ---------------------------------------------------------------------------------------------------------
-- imports: one row per import. Kept forever; the newest (highest seq) is the one the screens use.
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.imports (
  id         text primary key,                                  -- e.g. 20261029T180714454Z-3f9a
  seq        bigint generated always as identity unique,        -- save order: the highest is the latest import
  run_date   date not null,                                     -- the date the waitlist is read for
  created_at timestamptz not null default now(),
  files      jsonb not null,                                    -- { waitlist|openings|appointments: { name, sha256, text } }
  summary    jsonb not null                                     -- counts shown in B5
);

-- ---------------------------------------------------------------------------------------------------------
-- reading_cache: Claude's structured reading per person, keyed by a hash of their lines (no names, no phones).
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.reading_cache (
  key   text primary key,
  entry jsonb not null                                          -- { reading, readAt, by, problems }
);

-- ---------------------------------------------------------------------------------------------------------
-- booked: who filled which opening. The database itself enforces the two booking rules, so two taps at the
-- same moment from two devices can never both save:
--   * one booking per opening        -> opening_id is the primary key
--   * one live booking per person    -> unique (line_id, person_phone_digits); a newer waitlist line (new line
--                                       id) can be booked again
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.booked (
  opening_id          text primary key,                         -- one booking per opening
  seq                 bigint generated always as identity,      -- save order, to list ties in a fixed order
  person_phone_digits text not null,
  person_name         text not null,
  line_id             text not null,                            -- the person's newest line when booked
  "at"                timestamptz not null default now(),
  "by"                text not null                             -- which staff login marked it
);

create unique index if not exists booked_one_live_booking_per_person
  on public.booked (line_id, person_phone_digits);

-- ---------------------------------------------------------------------------------------------------------
-- booked_history: every undone booking, copied here before it leaves the booked table.
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.booked_history (
  id        bigint generated always as identity primary key,
  record    jsonb not null,                                     -- the booking as it was (same fields as the app uses)
  undone_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------
-- app_state: exactly one row (id = 1). version goes up by one on every change (import, Booked, undo).
-- Open screens listen to this row through Realtime and fetch fresh data when it changes.
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.app_state (
  id      smallint primary key default 1 check (id = 1),        -- only one row is allowed
  version bigint not null default 0
);

insert into public.app_state (id, version) values (1, 0)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- bump_version(): adds one to the version. It runs inside the same transaction as the change that caused it,
-- so the change and the new version are saved together or not at all. A refused booking (a duplicate) rolls
-- back before this runs, so refusals never bump the version.
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.bump_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.app_state set version = version + 1 where id = 1;
  return null;
end;
$$;

-- One bump per saved import, per new booking and per undone booking.
drop trigger if exists imports_bump_version on public.imports;
create trigger imports_bump_version
  after insert on public.imports
  for each row execute function public.bump_version();

drop trigger if exists booked_bump_version on public.booked;
create trigger booked_bump_version
  after insert or delete on public.booked
  for each row execute function public.bump_version();

-- ---------------------------------------------------------------------------------------------------------
-- undo_booked(opening): Undo. Moves the opening's booking to booked_history and removes it from booked, in one
-- step (nothing is lost, even if the server stops halfway). Returns true when there was a booking to undo.
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.undo_booked(p_opening_id text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  moved integer;
begin
  with gone as (
    delete from public.booked where opening_id = p_opening_id returning *
  )
  insert into public.booked_history (record, undone_at)
  select jsonb_build_object(
           'personPhoneDigits', person_phone_digits,
           'personName',        person_name,
           'lineId',            line_id,
           'openingId',         opening_id,
           'at',                to_char("at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'by',                "by"),
         now()
  from gone;
  get diagnostics moved = row_count;
  return moved > 0;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- shortlist_schema_report(): what `npm run check:db` asks, to say exactly what is missing. Read-only.
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.shortlist_schema_report()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_object_agg(t.name, jsonb_build_object(
               'exists', c.oid is not null,
               'rls',    coalesce(c.relrowsecurity, false))), '{}'::jsonb)
      from unnest(array['imports', 'reading_cache', 'booked', 'booked_history', 'app_state']) as t(name)
      left join pg_catalog.pg_class c
        on c.relname = t.name and c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
    ),
    'functions', (
      select coalesce(jsonb_object_agg(f.name, exists (
               select 1 from pg_catalog.pg_proc p
               where p.proname = f.name and p.pronamespace = 'public'::regnamespace)), '{}'::jsonb)
      from unnest(array['bump_version', 'undo_booked']) as f(name)
    ),
    'triggers', (
      select coalesce(jsonb_object_agg(g.name, exists (
               select 1 from pg_catalog.pg_trigger tr where tr.tgname = g.name and not tr.tgisinternal)), '{}'::jsonb)
      from unnest(array['imports_bump_version', 'booked_bump_version']) as g(name)
    ),
    'uniquePerPerson', exists (
      select 1 from pg_catalog.pg_indexes
      where schemaname = 'public' and indexname = 'booked_one_live_booking_per_person'),
    'appStateRow', exists (select 1 from public.app_state where id = 1),
    'realtime', exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_state')
  );
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Row level security on every table. With RLS on and no policy, a table is closed to the browser roles
-- (anon, authenticated); only the server's service-role key can use it.
-- ---------------------------------------------------------------------------------------------------------
alter table public.imports        enable row level security;
alter table public.reading_cache  enable row level security;
alter table public.booked         enable row level security;
alter table public.booked_history enable row level security;
alter table public.app_state      enable row level security;

-- The only client policy: logged-in staff may read the version row (it holds a number, nothing else).
drop policy if exists "staff can read the version" on public.app_state;
create policy "staff can read the version"
  on public.app_state
  for select
  to authenticated
  using (true);

-- Belt and braces: take the browser roles' table rights away too, then give back only reading app_state.
revoke all on table public.imports, public.reading_cache, public.booked, public.booked_history, public.app_state
  from anon, authenticated;
grant select on table public.app_state to authenticated;

-- The server (service-role key) needs explicit rights: newer projects may not grant new tables to the API roles
-- automatically, and then the app's key gets "table not found". RLS does not apply to service_role.
grant usage on schema public to service_role, authenticated;
grant select, insert, update, delete on table public.imports, public.reading_cache, public.booked,
  public.booked_history, public.app_state to service_role;
grant usage, select on all sequences in schema public to service_role;

-- The functions are for the server only.
revoke all on function public.bump_version() from public, anon, authenticated;
revoke all on function public.undo_booked(text) from public, anon, authenticated;
revoke all on function public.shortlist_schema_report() from public, anon, authenticated;
grant execute on function public.undo_booked(text) to service_role;
grant execute on function public.shortlist_schema_report() to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Realtime: publish changes to app_state so open screens hear about every change within a few seconds.
-- (Only app_state is published; the booked rows themselves never go out over Realtime.)
-- ---------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_state')
  then
    alter publication supabase_realtime add table public.app_state;
  end if;
end;
$$;

-- Tell the Data API to reload its list of tables and functions now (otherwise new tables can show as "not found").
notify pgrst, 'reload schema';
