// Loads .env.local for the check scripts, the same way the shortlist CLI and check:db do (values already in the
// environment win; SHORTLIST_SKIP_ENV_FILE=1 skips the file, so tests never pick up a real key).
import fs from 'node:fs';
import path from 'node:path';

export function loadEnvLocal(): void {
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
