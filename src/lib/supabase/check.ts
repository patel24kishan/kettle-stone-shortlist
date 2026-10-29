// `npm run check:db` (feature 6e): is the Supabase project ready for the app? Asks the project, never changes it,
// and never prints a key. Each problem comes with what to do about it.
import type { DbError, SupabaseLike } from '@/lib/storage/supabase';

export const TABLES = ['imports', 'reading_cache', 'booked', 'booked_history', 'app_state'] as const;
/** A small column per table, so the reachability check never downloads an import's files. */
const KEY_COLUMN: Record<(typeof TABLES)[number], string> = {
  imports: 'id',
  reading_cache: 'key',
  booked: 'opening_id',
  booked_history: 'id',
  app_state: 'id',
};
export const FUNCTIONS = ['bump_version', 'undo_booked'] as const;
export const TRIGGERS = ['imports_bump_version', 'booked_bump_version'] as const;

export const RUN_SCHEMA = 'Run supabase/schema.sql in the Supabase SQL editor (it is safe to run again).';

/** What shortlist_schema_report() returns (supabase/schema.sql). */
export interface SchemaReport {
  tables?: Record<string, { exists?: boolean; rls?: boolean }>;
  functions?: Record<string, boolean>;
  triggers?: Record<string, boolean>;
  uniquePerPerson?: boolean;
  appStateRow?: boolean;
  realtime?: boolean;
}

/** Everything missing from a schema report, in plain words. Empty when all is in place. */
export function schemaProblems(report: SchemaReport): string[] {
  const problems: string[] = [];
  for (const t of TABLES) {
    const info = report.tables?.[t];
    if (!info?.exists) problems.push(`Table ${t} is missing.`);
    else if (!info.rls) problems.push(`Row level security is off on ${t}.`);
  }
  for (const f of FUNCTIONS) if (!report.functions?.[f]) problems.push(`Function ${f}() is missing.`);
  for (const t of TRIGGERS) if (!report.triggers?.[t]) problems.push(`Trigger ${t} (the version bump) is missing.`);
  if (!report.uniquePerPerson) problems.push('The one-live-booking-per-person rule (unique index on booked) is missing.');
  if (!report.appStateRow) problems.push('The app_state row (the version number) is missing.');
  if (!report.realtime) problems.push('app_state is not in the supabase_realtime publication, so other screens only update by polling.');
  return problems;
}

/** A Supabase / network error in plain words, with the fix when there is a likely one. */
export function explainError(err: DbError | Error, host: string): string {
  const code = 'code' in err ? err.code : undefined;
  const message = err.message ?? '';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    return `Could not reach ${host}. Check NEXT_PUBLIC_SUPABASE_URL and the internet connection.`;
  }
  if (/invalid api key|jwt|unauthorized|no api key/i.test(message) || code === 'PGRST301' || code === '401') {
    return 'The project refused the service-role key. Copy SUPABASE_SERVICE_ROLE_KEY again from Project Settings > API keys.';
  }
  if (code === 'PGRST202' || code === '42883' || code === 'PGRST205' || code === '42P01') {
    return `The app's tables or functions are not in this project yet. ${RUN_SCHEMA}`;
  }
  return `Supabase answered with an error (${code ?? 'no code'}: ${message}).`;
}

export interface CheckResult {
  ok: boolean;
  lines: string[];
}

export interface CheckDeps {
  host: string;
  service: SupabaseLike;
  /** A client with the anon key and no session, or null when the anon key is not set. */
  anon: SupabaseLike | null;
}

/** Runs every check against the project. */
export async function checkProject({ host, service, anon }: CheckDeps): Promise<CheckResult> {
  const lines: string[] = [];
  const problems: string[] = [];

  let report: SchemaReport | null = null;
  try {
    const res = await service.rpc('shortlist_schema_report');
    if (res.error) {
      return { ok: false, lines: [`Supabase project: ${host}`, `PROBLEM: ${explainError(res.error, host)}`] };
    }
    report = (res.data ?? {}) as SchemaReport;
  } catch (err) {
    return { ok: false, lines: [`Supabase project: ${host}`, `PROBLEM: ${explainError(err as Error, host)}`] };
  }
  lines.push(`Supabase project: ${host} (reached)`);

  const missing = schemaProblems(report);
  problems.push(...missing);

  // Each table must also be reachable through the API the app uses.
  for (const t of TABLES) {
    if (report.tables?.[t]?.exists === false) continue;
    const res = await service.from(t).select(KEY_COLUMN[t]).limit(1);
    if (res.error) problems.push(`Table ${t}: ${explainError(res.error, host)}`);
  }

  // Row level security, seen from outside: without a login, nothing may be read.
  if (anon) {
    for (const t of TABLES) {
      const res = await anon.from(t).select(KEY_COLUMN[t]).limit(1);
      if (!res.error && (res.data ?? []).length > 0) problems.push(`Table ${t} can be read without signing in. ${RUN_SCHEMA}`);
    }
  } else {
    problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY is not set: staff cannot sign in and screens cannot use Realtime.');
  }

  if (missing.length > 0) problems.push(RUN_SCHEMA);
  if (problems.length === 0) {
    lines.push(`OK: tables ${TABLES.join(', ')} exist with row level security on.`);
    lines.push('OK: version triggers, undo_booked(), one booking per opening and per person, Realtime on app_state.');
    lines.push('OK: nothing can be read without signing in.');
    return { ok: true, lines };
  }
  for (const p of [...new Set(problems)]) lines.push(`PROBLEM: ${p}`);
  return { ok: false, lines };
}

/** Removes any of the given secret values from a line before it is printed. */
export function redact(line: string, secrets: string[]): string {
  let out = line;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[hidden]');
  return out;
}
