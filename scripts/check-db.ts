// npm run check:db (feature 6e): which store the app will use, and whether the Supabase project is ready.
//   No Supabase settings -> says the app uses the local store, and how to connect.
//   Settings present     -> checks the project can be reached, every table and the version function exist with row
//                           level security on, and nothing is readable without a login. Prints OK or what is missing.
// Reads .env.local like the shortlist CLI (values already in the environment win; SHORTLIST_SKIP_ENV_FILE=1 skips
// it). Never prints a key. Exit codes: 0 ready (or local mode), 1 something to fix.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseLike } from '../src/lib/storage/supabase';
import { checkProject, redact } from '../src/lib/supabase/check';
import { localDirForced, supabasePublicEnv, supabaseServerEnv } from '../src/lib/supabase/env';
import { createServiceClient } from '../src/lib/supabase/server';

function loadEnvLocal(): void {
  if (process.env.SHORTLIST_SKIP_ENV_FILE === '1') return;
  const file = path.resolve('.env.local');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trimStart().startsWith('#')) continue;
    const [, name, value] = m;
    if (process.env[name!] === undefined) process.env[name!] = value!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const isSet = (name: string) => ((process.env[name] ?? '').trim() ? 'set' : 'not set');

const HOW_TO_CONNECT = `To connect Supabase:
  1. Create a project (region ca-central-1, Canada Central).
  2. In the SQL editor, run supabase/schema.sql.
  3. Put these in .env.local (Project Settings > API keys):
       NEXT_PUBLIC_SUPABASE_URL=...
       NEXT_PUBLIC_SUPABASE_ANON_KEY=...
       SUPABASE_SERVICE_ROLE_KEY=...
     Then restart npm run dev, or run npm run build again (the URL and anon key are built into the app).
     On Vercel, add the same three under Settings > Environment Variables before deploying.
  4. Add staff logins under Authentication > Users, then run npm run check:db again.`;

async function main(): Promise<number> {
  loadEnvLocal();
  const server = supabaseServerEnv();
  const pub = supabasePublicEnv();
  const secrets = [process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''].map((s) => s.trim());
  const say = (line: string) => console.log(redact(line, secrets));

  say(
    `Settings: NEXT_PUBLIC_SUPABASE_URL ${isSet('NEXT_PUBLIC_SUPABASE_URL')}, NEXT_PUBLIC_SUPABASE_ANON_KEY ${isSet('NEXT_PUBLIC_SUPABASE_ANON_KEY')}, SUPABASE_SERVICE_ROLE_KEY ${isSet('SUPABASE_SERVICE_ROLE_KEY')}.`,
  );

  if (localDirForced()) {
    say(`The app is using the local store in ${path.resolve(process.env.SHORTLIST_DATA_DIR!.trim())} (SHORTLIST_DATA_DIR is set, and it always wins).`);
    return 0;
  }
  if (!server) {
    say('The app is using the local store (.data/app), with no staff login. Supabase is not connected.');
    say('');
    say(HOW_TO_CONNECT);
    return 0;
  }

  let host: string;
  try {
    host = new URL(server.url).host;
  } catch {
    say('PROBLEM: NEXT_PUBLIC_SUPABASE_URL is not a web address (it looks like https://<project>.supabase.co).');
    return 1;
  }
  say('The app will use Supabase (both NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set).');

  const anon: SupabaseLike | null = pub
    ? (createClient(pub.url, pub.anonKey, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as SupabaseLike)
    : null;
  const result = await checkProject({ host, service: createServiceClient(server), anon });
  for (const line of result.lines) say(line);
  say(result.ok ? 'Supabase is ready.' : 'Supabase is not ready yet: fix the problems above, then run npm run check:db again.');
  return result.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const secrets = [process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''].map((s) => s.trim());
    console.error(redact(`check:db failed: ${err instanceof Error ? err.message : String(err)}`, secrets));
    process.exitCode = 1;
  },
);
