// npm run check:db's checks (src/lib/supabase/check.ts, feature 6e) on fakes, plus the local-mode run of the script.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_SCHEMA, checkProject, explainError, redact, schemaProblems } from '@/lib/supabase/check';
import type { SchemaReport } from '@/lib/supabase/check';
import type { SupabaseLike } from '@/lib/storage/supabase';
import { FakeSupabase } from '../fakes/fake-supabase';

const FULL: SchemaReport = {
  tables: Object.fromEntries(['imports', 'reading_cache', 'booked', 'booked_history', 'app_state'].map((t) => [t, { exists: true, rls: true }])),
  functions: { bump_version: true, undo_booked: true },
  triggers: { imports_bump_version: true, booked_bump_version: true },
  uniquePerPerson: true,
  appStateRow: true,
  realtime: true,
};

function service(report: SchemaReport | null, error: { code: string; message: string } | null = null): SupabaseLike {
  const db = new FakeSupabase(0);
  return { from: (t) => db.from(t), rpc: async () => ({ data: report, error }) };
}

/** What a visitor with the anon key and no login sees: nothing (row level security, no anon policy). */
function anonView(): FakeSupabase {
  const db = new FakeSupabase(0);
  db.tables.app_state.length = 0;
  return db;
}

describe('check:db', () => {
  it('a complete schema has no problems, and the project check says OK', async () => {
    expect(schemaProblems(FULL)).toEqual([]);
    const res = await checkProject({ host: 'example.supabase.co', service: service(FULL), anon: anonView() });
    expect(res.ok).toBe(true);
    expect(res.lines.join('\n')).toMatch(/OK: tables imports, reading_cache, booked, booked_history, app_state exist with row level security on/);
  });

  it('names each missing part and says to run schema.sql', async () => {
    const partial: SchemaReport = {
      ...FULL,
      tables: { ...FULL.tables, booked: { exists: false, rls: false }, imports: { exists: true, rls: false } },
      functions: { bump_version: false, undo_booked: true },
      realtime: false,
    };
    expect(schemaProblems(partial)).toEqual([
      'Row level security is off on imports.',
      'Table booked is missing.',
      'Function bump_version() is missing.',
      'app_state is not in the supabase_realtime publication, so other screens only update by polling.',
    ]);
    const res = await checkProject({ host: 'example.supabase.co', service: service(partial), anon: anonView() });
    expect(res.ok).toBe(false);
    expect(res.lines).toContain(`PROBLEM: ${RUN_SCHEMA}`);
  });

  it('no schema at all (the report function is missing) -> run schema.sql', async () => {
    const res = await checkProject({
      host: 'example.supabase.co',
      service: service(null, { code: 'PGRST202', message: 'Could not find the function public.shortlist_schema_report' }),
      anon: null,
    });
    expect(res.ok).toBe(false);
    expect(res.lines.join('\n')).toContain('Run supabase/schema.sql in the Supabase SQL editor');
  });

  it('cannot reach the project / key refused are told apart', () => {
    expect(explainError(new TypeError('fetch failed'), 'example.supabase.co')).toMatch(/Could not reach example\.supabase\.co/);
    expect(explainError({ message: 'Invalid API key' }, 'h')).toMatch(/refused the service-role key/);
  });

  it('flags a table that can be read without signing in, and a missing anon key', async () => {
    const leaky = anonView();
    leaky.insertRow('booked', { opening_id: 'O1', person_phone_digits: '1', person_name: 'A', line_id: 'W1', at: '2026-10-21T10:00:00Z', by: 'x' });
    const res = await checkProject({ host: 'h', service: service(FULL), anon: leaky });
    expect(res.lines.join('\n')).toMatch(/Table booked can be read without signing in/);
    const noAnon = await checkProject({ host: 'h', service: service(FULL), anon: null });
    expect(noAnon.lines.join('\n')).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY is not set/);
  });

  it('redact hides key values', () => {
    expect(redact('error with sb_secret_abcdef123 inside', ['sb_secret_abcdef123'])).toBe('error with [hidden] inside');
  });

  it('with no Supabase settings the script reports the local store and how to connect', () => {
    const root = process.cwd();
    const env = { ...process.env, SHORTLIST_SKIP_ENV_FILE: '1' } as Record<string, string | undefined>;
    for (const n of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SHORTLIST_DATA_DIR']) delete env[n];
    const out = execFileSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/check-db.ts'], {
      cwd: root,
      env: env as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    expect(out).toMatch(/The app is using the local store/);
    expect(out).toMatch(/run supabase\/schema\.sql/);
  }, 30_000);
});
