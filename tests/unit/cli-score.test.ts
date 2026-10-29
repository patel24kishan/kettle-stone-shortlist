// Feature 5: the `score` command, spawned for real the way cli.test.ts spawns `run`.
// Expected behaviour: ../build-plan.md section 6 Step 5. Exit 0 when it ran (even with mismatches), 1 for
// unreadable or invalid files, 2 for bad arguments. It reads files only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE = path.join(ROOT, 'data', 'sample');
const sample = (f: string) => path.join(SAMPLE, f);
const KEY = sample('answer-key-tanya.csv');
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const TIMEOUT = 120_000;

const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(sample(f)));

let TMP = '';
let RUN_DIR = '';

function cli(args: string[]) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.SHORTLIST_SKIP_ENV_FILE = '1';
  const res = spawnSync(process.execPath, [TSX_CLI, 'scripts/shortlist.ts', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-cli-score-'));
  RUN_DIR = path.join(TMP, 'run');
  const res = cli([
    'run',
    '--waitlist', sample('waitlist-2026-10-21.csv'),
    '--appointments', sample('appointments-2026-09-21-to-2026-10-17.csv'),
    '--openings', sample('late-openings-2026-09-21-to-2026-10-17.csv'),
    '--run-date', '2026-10-21',
    '--out-dir', RUN_DIR,
    '--cache', path.join(TMP, 'cache.json'),
  ]);
  if (res.code !== 0) throw new Error(`run failed: ${res.stderr}`);
}, TIMEOUT);

afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(sample(f)).equals(bytes), f).toBe(true);
});

const resultsPath = () => path.join(RUN_DIR, 'results.csv');
const verdictsPath = () => path.join(RUN_DIR, 'line_verdicts.csv');

describe('shortlist score', () => {
  it(
    'scores a run: exit 0, 44/44 and 60/60, uses the line_verdicts.csv next to the results, writes nothing',
    () => {
      const before = fs.readdirSync(RUN_DIR).sort();
      const res = cli(['score', '--results', resultsPath(), '--key', KEY]);
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain('Openings: 44/44 match (Friday rule) · 44/44 equal');
      expect(res.stdout).toContain('Lines: 60/60');
      expect(res.stdout).toContain('line_verdicts.csv');
      expect(res.stdout).not.toContain('MISMATCH');
      expect(fs.readdirSync(RUN_DIR).sort()).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    'takes --verdicts explicitly; without a verdicts file next to the results the lines are not scored',
    () => {
      const lone = path.join(TMP, 'lone');
      fs.mkdirSync(lone);
      fs.copyFileSync(resultsPath(), path.join(lone, 'results.csv'));
      const without = cli(['score', '--results', path.join(lone, 'results.csv'), '--key', KEY]);
      expect(without.code, without.stderr).toBe(0);
      expect(without.stdout).toContain('Openings: 44/44');
      expect(without.stdout).toContain('Lines: not scored');

      const withFlag = cli(['score', '--results', path.join(lone, 'results.csv'), '--key', KEY, '--verdicts', verdictsPath()]);
      expect(withFlag.code, withFlag.stderr).toBe(0);
      expect(withFlag.stdout).toContain('Lines: 60/60');
    },
    TIMEOUT,
  );

  it(
    'a wrong name added to a copy of results.csv shows the mismatch and the summary drops to 43/44',
    () => {
      const copy = path.join(TMP, 'edited');
      fs.mkdirSync(copy);
      // O02 is a no-show: the key says nobody, so adding a name there is wrong
      const edited = fs.readFileSync(resultsPath(), 'utf8').replace(/^O02,none$/m, 'O02,W01 Nobody Real (506-555-0000)');
      expect(edited).toContain('O02,W01');
      fs.writeFileSync(path.join(copy, 'results.csv'), edited, 'utf8');
      const res = cli(['score', '--results', path.join(copy, 'results.csv'), '--key', KEY, '--verdicts', verdictsPath()]);
      expect(res.code, res.stderr).toBe(0); // it ran, so exit 0 even with a mismatch
      expect(res.stdout).toMatch(/O02\s+MISMATCH.*we showed 1 name but Tanya says nobody/);
      expect(res.stdout).toContain('Openings: 43/44 match (Friday rule)');
    },
    TIMEOUT,
  );

  it(
    'missing --key exits 2 with usage',
    () => {
      const res = cli(['score', '--results', resultsPath()]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain('--key');
      expect(res.stderr).toContain('Usage');
      expect(cli(['score']).code).toBe(2);
      expect(cli(['score', '--results', resultsPath(), '--key', KEY, '--bogus']).code).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'a bad key file, a missing file and a malformed results file exit 1 with a clear message',
    () => {
      const badKey = path.join(TMP, 'bad-key.csv');
      fs.writeFileSync(badKey, 'id,type,answer\nO01,opening,none\n', 'utf8');
      const a = cli(['score', '--results', resultsPath(), '--key', badKey]);
      expect(a.code).toBe(1);
      expect(a.stderr).toContain('bad-key.csv');
      expect(a.stderr).toContain('marked_by');

      const b = cli(['score', '--results', resultsPath(), '--key', path.join(TMP, 'nope.csv')]);
      expect(b.code).toBe(1);
      expect(b.stderr).toContain('nope.csv');

      const badResults = path.join(TMP, 'bad-results.csv');
      fs.writeFileSync(badResults, 'opening_id,shortlist\nO01,Luc Bernard\n', 'utf8');
      const c = cli(['score', '--results', badResults, '--key', KEY]);
      expect(c.code).toBe(1);
      expect(c.stderr).toContain('O01');
      expect(c.stderr).toContain('Luc Bernard');
    },
    TIMEOUT,
  );
});
