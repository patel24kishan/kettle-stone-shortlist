// supabase/schema.sql (feature 6e) read as text: the safety rules are in it. No database needed.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = fs.readFileSync(path.join(process.cwd(), 'supabase', 'schema.sql'), 'utf8');
// Comments removed and whitespace squeezed, so the checks look at the SQL only.
const sql = raw
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const TABLES = ['imports', 'reading_cache', 'booked', 'booked_history', 'app_state'];
const SERVER_ONLY = ['imports', 'booked', 'reading_cache', 'booked_history'];

/** Every `create policy ... on <table> ...` statement. */
const policies = [...sql.matchAll(/create policy "[^"]*" on public\.(\w+)([^;]*);/g)].map((m) => ({ table: m[1]!, body: m[2]! }));

describe('supabase/schema.sql', () => {
  it('creates every table, and only if it is not there yet (safe to run again)', () => {
    for (const t of TABLES) expect(sql).toContain(`create table if not exists public.${t} (`);
    expect(sql).not.toMatch(/\bdrop table\b|\btruncate\b|\bdelete from public\.(imports|booked_history|reading_cache)\b/);
  });

  it('turns row level security on for every table', () => {
    for (const t of TABLES) expect(sql).toContain(`alter table public.${t} enable row level security;`);
  });

  it('one booking per opening: opening_id is the primary key of booked', () => {
    expect(sql).toMatch(/create table if not exists public\.booked \( opening_id text primary key,/);
  });

  it('one live booking per person: a unique index on (line_id, person_phone_digits)', () => {
    expect(sql).toContain(
      'create unique index if not exists booked_one_live_booking_per_person on public.booked (line_id, person_phone_digits);',
    );
  });

  it('imports and readings have unique keys; app_state is a single row', () => {
    expect(sql).toMatch(/create table if not exists public\.imports \( id text primary key,/);
    expect(sql).toMatch(/create table if not exists public\.reading_cache \( key text primary key,/);
    expect(sql).toContain('check (id = 1)');
    expect(sql).toContain('insert into public.app_state (id, version) values (1, 0) on conflict (id) do nothing;');
  });

  it('bumps the version inside the change itself: triggers on imports and booked', () => {
    expect(sql).toContain('create or replace function public.bump_version() returns trigger');
    expect(sql).toContain('update public.app_state set version = version + 1 where id = 1;');
    expect(sql).toMatch(/create trigger imports_bump_version after insert on public\.imports for each row execute function public\.bump_version\(\);/);
    expect(sql).toMatch(
      /create trigger booked_bump_version after insert or delete on public\.booked for each row execute function public\.bump_version\(\);/,
    );
  });

  it('undo moves the row to booked_history in the same statement (nothing is lost)', () => {
    expect(sql).toContain('create or replace function public.undo_booked(p_opening_id text) returns boolean');
    expect(sql).toMatch(/with gone as \( delete from public\.booked where opening_id = p_opening_id returning \* \) insert into public\.booked_history/);
  });

  it('adds app_state (and only app_state) to the supabase_realtime publication', () => {
    expect(sql).toContain('alter publication supabase_realtime add table public.app_state;');
    const published = [...sql.matchAll(/alter publication supabase_realtime add table public\.(\w+)/g)].map((m) => m[1]);
    expect(published).toEqual(['app_state']);
  });

  it('has no client policy on imports, booked, reading_cache or booked_history', () => {
    for (const t of SERVER_ONLY) expect(policies.filter((p) => p.table === t)).toEqual([]);
    expect(sql).not.toMatch(/to (anon|authenticated|public)[^;]*on public\.(imports|booked|reading_cache|booked_history)\b/);
    for (const t of SERVER_ONLY) expect(sql).not.toMatch(new RegExp(`grant [^;]* on table public\\.${t}\\b[^;]* to (anon|authenticated)`));
  });

  it('the only client policy lets signed-in staff read app_state, and nothing else', () => {
    expect(policies).toHaveLength(1);
    expect(policies[0]!.table).toBe('app_state');
    expect(policies[0]!.body).toMatch(/^ for select to authenticated using \(true\)$/);
    expect(sql).toContain('grant select on table public.app_state to authenticated;');
  });

  it('takes table rights away from the browser roles and keeps the functions for the server', () => {
    expect(sql).toMatch(
      /revoke all on table public\.imports, public\.reading_cache, public\.booked, public\.booked_history, public\.app_state from anon, authenticated;/,
    );
    for (const f of ['bump_version()', 'undo_booked(text)', 'shortlist_schema_report()']) {
      expect(sql).toContain(`revoke all on function public.${f} from public, anon, authenticated;`);
    }
    expect(sql).not.toMatch(/grant execute on function [^;]* to (anon|authenticated|public)/);
  });

  it('pins search_path on every function (no lookup tricks)', () => {
    const functions = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    expect(functions).toEqual(['bump_version', 'undo_booked', 'shortlist_schema_report']);
    expect(sql.match(/set search_path = ''/g)).toHaveLength(functions.length);
  });
});
