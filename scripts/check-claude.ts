// npm run check:claude (feature 7): is Claude connected for reading the waitlist notes?
//   No ANTHROPIC_API_KEY -> says the app uses the saved readings only, and how to add the key (exit 0).
//   Key set              -> one small test reading (a made-up line, no client data; about one to three cents),
//                           checked like an import checks it. Prints OK + model + token usage + cost (exit 0), or the
//                           exact failure and what to do (exit 1). The key is never printed.
// Reads .env.local like the shortlist CLI (values already in the environment win; SHORTLIST_SKIP_ENV_FILE=1 skips it).
import { checkClaude } from '../src/lib/check-claude';
import { redact } from '../src/lib/supabase/check';
import { loadEnvLocal } from './env-local';

async function main(): Promise<number> {
  loadEnvLocal();
  const result = await checkClaude({ apiKey: process.env.ANTHROPIC_API_KEY });
  for (const line of result.lines) console.log(line);
  return result.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const key = (process.env.ANTHROPIC_API_KEY ?? '').trim();
    console.error(redact(`check:claude failed: ${err instanceof Error ? err.message : String(err)}`, [key]));
    process.exitCode = 1;
  },
);
