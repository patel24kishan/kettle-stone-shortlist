// Feature 4: the command line, spawned for real (npx tsx scripts/shortlist.ts run ...).
// Expected behaviour: ../build-plan.md section 6 Step 4 and 7 (one command, no hand edits, same input same
// output); ../rules.md "Always". The child never gets an ANTHROPIC_API_KEY, so Claude is never called.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRunCache } from '@/lib/cache-setup';
import { resultsCsv, runShortlist } from '@/lib/run';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE = path.join(ROOT, 'data', 'sample');
const WAITLIST_FILE = 'waitlist-2026-10-21.csv';
const APPTS_FILE = 'appointments-2026-09-21-to-2026-10-17.csv';
const OPENINGS_FILE = 'late-openings-2026-09-21-to-2026-10-17.csv';
const sample = (f: string) => path.join(SAMPLE, f);

const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(sample(f)));

let TMP = '';
let n = 0;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-cli-'));
});
afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(sample(f)).equals(bytes), f).toBe(true);
  expect(fs.readdirSync(SAMPLE).sort()).toEqual([...sampleBytes.keys()].sort());
});

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.SHORTLIST_SKIP_ENV_FILE = '1'; // never read a real key from .env.local
  return env;
}

// `npx tsx scripts/shortlist.ts ...` without a shell: node runs tsx's own entry file. A shell would split the
// paths (this project's folder name has spaces), and npx.cmd cannot be spawned without one on Windows.
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function cli(args: string[]) {
  const res = spawnSync(process.execPath, [TSX_CLI, 'scripts/shortlist.ts', ...args], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 90_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface Sandbox {
  outDir: string;
  cache: string;
}
const sandbox = (): Sandbox => {
  const dir = path.join(TMP, `box-${++n}`);
  fs.mkdirSync(dir);
  return { outDir: path.join(dir, 'run'), cache: path.join(dir, 'cache.json') };
};

function runArgs(box: Sandbox, over: { waitlist?: string; openings?: string; extra?: string[] } = {}) {
  return [
    'run',
    '--waitlist', over.waitlist ?? sample(WAITLIST_FILE),
    '--appointments', sample(APPTS_FILE),
    '--openings', over.openings ?? sample(OPENINGS_FILE),
    '--run-date', '2026-10-21',
    '--out-dir', box.outDir,
    '--cache', box.cache,
    ...(over.extra ?? []),
  ];
}

const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const TIMEOUT = 120_000;

describe('shortlist CLI', () => {
  it(
    'runs the sample: exit 0, three files, results.csv equals resultsCsv of runShortlist, summary printed',
    async () => {
      const box = sandbox();
      const res = cli(runArgs(box));
      expect(res.code, res.stderr).toBe(0);
      for (const f of ['results.csv', 'line_verdicts.csv', 'run.json']) expect(fs.existsSync(path.join(box.outDir, f)), f).toBe(true);

      const expected = await runShortlist({
        waitlistText: fs.readFileSync(sample(WAITLIST_FILE), 'utf8'),
        appointmentsText: fs.readFileSync(sample(APPTS_FILE), 'utf8'),
        openingsText: fs.readFileSync(sample(OPENINGS_FILE), 'utf8'),
        runDate: '2026-10-21',
        cache: openRunCache(path.join(box.outDir, '..', 'expected-cache.json')),
        client: null,
      });
      expect(read(box.outDir, 'results.csv')).toBe(resultsCsv(expected.results));

      expect(res.stdout).toContain('44 openings searched · 34 have people · 10 nobody');
      expect(res.stdout).toContain('30 people');
      expect(res.stdout).toContain('45 saved/cached · 0 read by Claude · 0 not read');
      expect(res.stdout).not.toContain('WARNING');

      const runJson = JSON.parse(read(box.outDir, 'run.json')) as Record<string, any>;
      expect(runJson.runDate).toBe('2026-10-21');
      expect(runJson.summary).toEqual(expected.summary);
      expect(runJson.inputs.waitlist.file).toBe(WAITLIST_FILE);
      expect(runJson.inputs.waitlist.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(runJson.settings).toEqual({ noticeFrom: 'cancelled', allowLongerOpening: true, noticeEqualIsEnough: true });
      expect(typeof runJson.createdAt).toBe('string');
      // the cache was created from the sample readings, and the sample readings file was not touched
      expect(Object.keys(JSON.parse(read(box.cache)))).toHaveLength(45);
    },
    TIMEOUT,
  );

  it(
    'also writes results.csv to --out',
    () => {
      const box = sandbox();
      const out = path.join(TMP, `extra-${n}`, 'results.csv');
      const res = cli(runArgs(box, { extra: ['--out', out] }));
      expect(res.code, res.stderr).toBe(0);
      expect(read(out)).toBe(read(box.outDir, 'results.csv'));
    },
    TIMEOUT,
  );

  it(
    'two runs on the same input: results.csv, line_verdicts.csv and run.json (bar created-at) are byte-identical',
    () => {
      const a = sandbox();
      const b = sandbox();
      expect(cli(runArgs(a)).code).toBe(0);
      expect(cli(runArgs(b)).code).toBe(0);
      for (const f of ['results.csv', 'line_verdicts.csv']) {
        expect(fs.readFileSync(path.join(a.outDir, f)).equals(fs.readFileSync(path.join(b.outDir, f))), f).toBe(true);
      }
      const strip = (dir: string) => read(dir, 'run.json').replace(/"createdAt": "[^"]*"/, '"createdAt": ""');
      expect(strip(a.outDir)).toBe(strip(b.outDir));
      // a second run into the same folder and cache also gives the same files
      const before = read(a.outDir, 'results.csv');
      expect(cli(runArgs(a)).code).toBe(0);
      expect(read(a.outDir, 'results.csv')).toBe(before);
    },
    TIMEOUT,
  );

  it(
    'a waitlist missing notes: exit 1, stderr names the file and the column, nothing is written',
    () => {
      const box = sandbox();
      const bad = path.join(TMP, `bad-waitlist-${n}.csv`);
      fs.writeFileSync(bad, fs.readFileSync(sample(WAITLIST_FILE), 'utf8').replace('notes', 'comments'), 'utf8');
      const res = cli(runArgs(box, { waitlist: bad }));
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('bad-waitlist');
      expect(res.stderr).toContain('notes');
      expect(fs.existsSync(path.join(box.outDir, 'results.csv'))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'bad arguments exit 2 with a usage message',
    () => {
      const box = sandbox();
      const noDate = cli(['run', '--waitlist', sample(WAITLIST_FILE), '--appointments', sample(APPTS_FILE), '--openings', sample(OPENINGS_FILE)]);
      expect(noDate.code).toBe(2);
      expect(noDate.stderr).toContain('--run-date');
      expect(noDate.stderr).toContain('Usage');

      const badDate = cli(runArgs(box).map((a) => (a === '2026-10-21' ? '2026-02-30' : a)));
      expect(badDate.code).toBe(2);
      expect(badDate.stderr).toContain('2026-02-30');

      const unknownFlag = cli([...runArgs(box), '--bogus']);
      expect(unknownFlag.code).toBe(2);

      const overwritesInput = cli(runArgs(box, { extra: ['--out', sample(WAITLIST_FILE)] }));
      expect(overwritesInput.code).toBe(2);

      const unknownCommand = cli(['frobnicate']);
      expect(unknownCommand.code).toBe(2);
      expect(unknownCommand.stderr).toContain('Usage');
    },
    TIMEOUT,
  );

  it(
    'a waitlist with a new line and no Claude key: exit 0, warning names W61, W61 is never offered',
    () => {
      const box = sandbox();
      const extra = path.join(TMP, `waitlist-extra-${n}.csv`);
      fs.writeFileSync(extra, `${fs.readFileSync(sample(WAITLIST_FILE), 'utf8')}61,10/20,Test Person,506-555-0199,any - 60\r\n`, 'utf8');
      const res = cli(runArgs(box, { waitlist: extra }));
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain('WARNING');
      expect(res.stdout).toContain('W61');
      expect(res.stdout).toContain('ANTHROPIC_API_KEY');
      expect(res.stdout).toContain('not offered');
      expect(res.stdout).toContain('1 not read');
      expect(read(box.outDir, 'results.csv')).not.toContain('Test Person');
      expect(JSON.parse(read(box.outDir, 'run.json')).summary.notRead).toEqual(['W61']);
    },
    TIMEOUT,
  );
});
