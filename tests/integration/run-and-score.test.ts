// Integration: Features 1-5 together. The Friday hand-in loop (CLI `run`, then CLI `score` on that run folder),
// the scorer against a Friday-shaped key that covers only some openings, edited results that test precision,
// a Booked change through the library, and a check that the scorer never writes anything.
// Expected behaviour: ../build-plan.md section 1 (how Friday is scored: every name shown must be on Tanya's list;
// nobody = nobody; order does not count; fewer than 3 is fine; the key covers only the 10 new openings),
// section 6 Steps 4-5 and section 7 (done checks).
// The CLI child never gets an ANTHROPIC_API_KEY (and never reads .env.local); in-process runs pass client: null.
// Claude is never called. Sample files are never modified: every run works in a temp folder.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRunCache } from '@/lib/cache-setup';
import { lineVerdictsCsv, resultsCsv, runShortlist } from '@/lib/run';
import type { RunOutput } from '@/lib/run';
import {
  formatReport,
  parseAnswerKey,
  parseLineVerdictsCsv,
  parseResultsCsv,
  scoreLines,
  scoreOpenings,
} from '@/lib/score';
import type { BookedRecord } from '@/lib/types';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE = path.join(ROOT, 'data', 'sample');
const sample = (f: string) => path.join(SAMPLE, f);
const sampleText = (f: string) => fs.readFileSync(sample(f), 'utf8');
const WAITLIST_FILE = 'waitlist-2026-10-21.csv';
const APPTS_FILE = 'appointments-2026-09-21-to-2026-10-17.csv';
const OPENINGS_FILE = 'late-openings-2026-09-21-to-2026-10-17.csv';
const KEY_FILE = 'answer-key-tanya.csv';
const KEY = sample(KEY_FILE);
const RUN_DATE = '2026-10-21';
const TIMEOUT = 180_000;

// ---- snapshots: nothing outside the temp dir is touched -------------------------------------------------

/** Every file under `dir` (relative path -> bytes). An absent dir gives an empty map. */
function filesUnder(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out.set(path.relative(dir, full), fs.readFileSync(full));
  }
  return out;
}
const sameFiles = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v) === true);

function projectSnapshot() {
  return {
    top: fs.readdirSync(ROOT).sort(),
    runs: filesUnder(path.join(ROOT, 'runs')),
    data: filesUnder(path.join(ROOT, '.data')),
  };
}

// ---- spawning the CLI (same approach as tests/unit/cli-score.test.ts) ----------------------------------

// node runs tsx's own entry file, with no shell: the project folder has spaces, and npx.cmd needs a shell on Windows.
const TSX_CLI = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function cli(args: string[]) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.SHORTLIST_SKIP_ENV_FILE = '1'; // never read a real key from .env.local
  const res = spawnSync(process.execPath, [TSX_CLI, 'scripts/shortlist.ts', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const score = (results: string, key: string, verdicts?: string) =>
  cli(['score', '--results', results, '--key', key, ...(verdicts ? ['--verdicts', verdicts] : [])]);

/** The report part of `score` stdout: everything after the three header lines and the blank line. */
function reportOf(stdout: string): string {
  const lines = stdout.split('\n');
  expect(lines[0]).toMatch(/^Results: /);
  expect(lines[1]).toMatch(/^Key: /);
  expect(lines[2]).toMatch(/^Verdicts: /);
  expect(lines[3]).toBe('');
  return lines.slice(4).join('\n');
}

/** The per-opening rows of a report, by opening id. */
function reportRows(report: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of report.split('\n')) {
    const m = /^(O\d+)\s+(match|MISMATCH)\s/.exec(line);
    if (m) rows.set(m[1]!, line);
  }
  return rows;
}

// ---- shared state ----------------------------------------------------------------------------------------

let TMP = '';
let RUN_DIR = '';
let n = 0;
const sampleBefore = filesUnder(SAMPLE);
let projectBefore: ReturnType<typeof projectSnapshot>;
let runDirBefore: Map<string, Buffer>;

const resultsPath = () => path.join(RUN_DIR, 'results.csv');
const verdictsPath = () => path.join(RUN_DIR, 'line_verdicts.csv');

function freshDir(label: string): string {
  const dir = path.join(TMP, `${label}-${++n}`);
  fs.mkdirSync(dir);
  return dir;
}

/** The sample run in-process, no Claude, no Booked marks (or the ones given). */
function libraryRun(booked: BookedRecord[] = []): Promise<RunOutput> {
  return runShortlist({
    waitlistText: sampleText(WAITLIST_FILE),
    appointmentsText: sampleText(APPTS_FILE),
    openingsText: sampleText(OPENINGS_FILE),
    runDate: RUN_DATE,
    cache: openRunCache(path.join(freshDir('lib'), 'cache.json')),
    client: null,
    booked,
  });
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-run-and-score-'));
  projectBefore = projectSnapshot();
  RUN_DIR = path.join(TMP, 'run');
  const res = cli([
    'run',
    '--waitlist', sample(WAITLIST_FILE),
    '--appointments', sample(APPTS_FILE),
    '--openings', sample(OPENINGS_FILE),
    '--run-date', RUN_DATE,
    '--out-dir', RUN_DIR,
    '--cache', path.join(TMP, 'cache.json'),
  ]);
  if (res.code !== 0) throw new Error(`run failed (${res.code}): ${res.stderr}`);
  // Taken right after the run, before any score: test 5 compares against this.
  runDirBefore = filesUnder(RUN_DIR);
}, TIMEOUT);

afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  expect(sameFiles(filesUnder(SAMPLE), sampleBefore), 'data/sample/ unchanged').toBe(true);
  const after = projectSnapshot();
  expect(after.top).toEqual(projectBefore.top);
  expect(sameFiles(after.runs, projectBefore.runs), 'runs/ unchanged').toBe(true);
  expect(sameFiles(after.data, projectBefore.data), '.data/ unchanged').toBe(true);
});

// =========================================================================================================

describe('1. the hand-in loop: run, then score that run folder', () => {
  it(
    'score exits 0 with 44/44, 44/44 and Lines: 60/60; the report equals the in-process score of runShortlist',
    async () => {
      expect(fs.readdirSync(RUN_DIR).sort()).toEqual(['line_verdicts.csv', 'results.csv', 'run.json']);

      const res = score(resultsPath(), KEY); // line_verdicts.csv is found next to results.csv
      expect(res.code, res.stderr).toBe(0);
      expect(res.stderr).toBe('');
      expect(res.stdout).toContain("Openings: 44/44 match (Friday rule) · 44/44 equal Tanya's first 3");
      expect(res.stdout).toContain('Lines: 60/60');
      expect(res.stdout).toMatch(/^Verdicts: .*line_verdicts\.csv$/m);
      expect(res.stdout).not.toContain('MISMATCH');
      expect(res.stdout).not.toContain('Not in the key');

      // The same thing in-process, from runShortlist's output (not from the CLI's files).
      const lib = await libraryRun();
      const key = parseAnswerKey(sampleText(KEY_FILE));
      const openings = scoreOpenings(parseResultsCsv(resultsCsv(lib.results)), key);
      const lines = scoreLines(parseLineVerdictsCsv(lineVerdictsCsv(lib.lines, lib.verdicts, lib.reasons)), key);
      expect(openings.totals).toEqual({ openings: 44, fridayMatches: 44, first3Matches: 44 });
      expect(openings.notInKey).toEqual([]);
      expect(openings.scores.every((s) => s.problem === null && !s.missing)).toBe(true);
      expect(lines.totals).toEqual({ lines: 60, matches: 60 });
      expect(lines.notInKey).toEqual([]);

      // Byte for byte the CLI's report is the library's report.
      expect(reportOf(res.stdout)).toBe(formatReport(openings, lines));
      const rows = reportRows(reportOf(res.stdout));
      expect(rows.size).toBe(44);
    },
    TIMEOUT,
  );
});

// ---- the Friday-shaped key -------------------------------------------------------------------------------

// Ten of the sample's openings, as Friday's key will cover only the 10 new ones: 2 no-shows (O02, O07),
// the two "nobody fits" openings (O31, O40), single-name (O30, O13), short list (O32), long list (O34), and two more.
const SUBSET = ['O01', 'O02', 'O07', 'O13', 'O30', 'O31', 'O32', 'O34', 'O40', 'O44'];

/** The sample key with only the SUBSET opening rows and no waitlist line rows, rows kept exactly as written. */
function subsetKeyText(): string {
  const [header, ...rows] = sampleText(KEY_FILE).split('\r\n');
  const kept = rows.filter((r) => SUBSET.includes(r.split(',')[0]!) && r.split(',')[1] === 'opening');
  expect(kept).toHaveLength(SUBSET.length);
  return `${[header, ...kept].join('\r\n')}\r\n`;
}

describe('2. a Friday-shaped key (10 openings, no line rows)', () => {
  it(
    'scores 10/10, says lines are not scored because the key has no line rows, and lists the other 34 as not in the key',
    () => {
      const keyPath = path.join(freshDir('subset-key'), 'answer-key-friday.csv');
      fs.writeFileSync(keyPath, subsetKeyText(), 'utf8');
      const key = parseAnswerKey(fs.readFileSync(keyPath, 'utf8'));
      expect([...key.openings.keys()]).toEqual(SUBSET);
      expect(key.lines.size).toBe(0);

      const res = score(resultsPath(), keyPath); // verdicts file is next to the results, but the key has no lines
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain("Openings: 10/10 match (Friday rule) · 10/10 equal Tanya's first 3");
      expect(res.stdout).toContain('Lines: not scored (the key has no waitlist line rows)');
      expect(res.stdout).not.toMatch(/Lines: \d+\/\d+/);
      expect(res.stdout).not.toContain('MISMATCH');

      // Only the 10 key openings get a row, in the key's order.
      const report = reportOf(res.stdout);
      expect([...reportRows(report).keys()]).toEqual(SUBSET);

      // The other 34 are listed as not scored, in results.csv order.
      const allIds = [...parseResultsCsv(fs.readFileSync(resultsPath(), 'utf8')).keys()];
      const others = allIds.filter((id) => !SUBSET.includes(id));
      expect(others).toHaveLength(34);
      expect(report).toContain(`Not in the key, so not scored (34): ${others.join(', ')}`);

      // The nobody openings: no-shows and the two nobody-fits are "ours nobody | Tanya nobody".
      const rows = reportRows(report);
      for (const id of ['O02', 'O07', 'O31', 'O40']) expect(rows.get(id), id).toMatch(/ours nobody \| Tanya nobody$/);

      // Same as the library: the line scorer sees no key lines, so every verdict line is "not in key".
      const lines = scoreLines(parseLineVerdictsCsv(fs.readFileSync(verdictsPath(), 'utf8')), key);
      expect(lines.totals).toEqual({ lines: 0, matches: 0 });
      expect(lines.notInKey).toHaveLength(60);
      const openings = scoreOpenings(parseResultsCsv(fs.readFileSync(resultsPath(), 'utf8')), key);
      expect(openings.notInKey).toEqual(others);
      expect(report).toBe(formatReport(openings, lines));
    },
    TIMEOUT,
  );
});

// ---- precision is what is scored -------------------------------------------------------------------------

describe('3. precision is what is scored: edited copies of the real results.csv', () => {
  it(
    'fewer names stays a Friday match; a name where Tanya says nobody, or a name from another list, is a mismatch',
    () => {
      const original = fs.readFileSync(resultsPath(), 'utf8');
      const row = (id: string) => new RegExp(`^${id},.*$`, 'm');
      expect(original).toMatch(/^O34,W33 [^;]+; W42 [^;]+; W48 [^;]+$/m);
      expect(original).toMatch(/^O31,none$/m);
      expect(original).toMatch(/^O32,W42 [^;]+; W49 [^;]+$/m);

      // W46 Shawn Duguay is on O30's list (and many others) but not on O32's or O31's.
      const key = parseAnswerKey(sampleText(KEY_FILE));
      expect(key.openings.get('O30')).toEqual(['W46']);
      expect(key.openings.get('O32')).not.toContain('W46');
      expect(key.openings.get('O31')).toEqual([]);
      const shawn = 'W46 Shawn Duguay (506-555-0140)';
      expect(original).toContain(shawn);

      const o34 = original.match(row('O34'))![0];
      const o32 = original.match(row('O32'))![0];
      const edited = original
        .replace(row('O34'), o34.replace(/; W48 [^;]+$/, '')) // (a) drop the third name
        .replace(row('O31'), `O31,${shawn}`) // (b) a name where Tanya says nobody
        .replace(row('O32'), `${o32}; ${shawn}`); // (c) a name from another opening's list
      expect(edited.match(row('O34'))![0]).toMatch(/^O34,W33 [^;]+; W42 [^;]+$/);
      expect(edited).not.toBe(original);

      const dir = freshDir('edited');
      const editedPath = path.join(dir, 'results.csv');
      fs.writeFileSync(editedPath, edited, 'utf8');

      const res = score(editedPath, KEY, verdictsPath());
      expect(res.code, res.stderr).toBe(0); // it ran, so exit 0 even with mismatches
      const report = reportOf(res.stdout);
      const rows = reportRows(report);

      // (a) still a match, but not Tanya's first 3
      expect(rows.get('O34')).toMatch(/^O34\s+match\s+ours W33 W42 \| Tanya .*\(not Tanya's first 3\)$/);
      // (b) a mismatch: names where Tanya says nobody
      expect(rows.get('O31')).toMatch(/^O31\s+MISMATCH\s+ours W46 \| Tanya nobody\s+<-- we showed 1 name but Tanya says nobody$/);
      // (c) a mismatch naming the wrong line id; the full list is shown because it explains the miss
      expect(rows.get('O32')).toMatch(/^O32\s+MISMATCH\s+ours W42 W49 W46 \| Tanya W42 W49\s+<-- W46 is not on Tanya's list$/);

      const mismatches = [...rows.values()].filter((l) => /\sMISMATCH\s/.test(l));
      expect(mismatches).toHaveLength(2);
      // Friday count drops by exactly the number of mismatches; first-3 drops by all three edits.
      expect(report).toContain("Openings: 42/44 match (Friday rule) · 41/44 equal Tanya's first 3");
      expect(report).toContain('Lines: 60/60');

      // Same numbers in-process.
      const openings = scoreOpenings(parseResultsCsv(edited), key);
      expect(openings.totals).toEqual({ openings: 44, fridayMatches: 44 - mismatches.length, first3Matches: 41 });
      expect(openings.scores.filter((s) => !s.fridayMatch).map((s) => s.id)).toEqual(['O31', 'O32']);
      expect(openings.scores.filter((s) => !s.first3Match).map((s) => s.id)).toEqual(['O31', 'O32', 'O34']);
      expect(report).toBe(formatReport(openings, scoreLines(parseLineVerdictsCsv(fs.readFileSync(verdictsPath(), 'utf8')), key)));

      // Each edit alone costs exactly what it should.
      const one = (text: string) => scoreOpenings(parseResultsCsv(text), key).totals;
      expect(one(original.replace(row('O34'), edited.match(row('O34'))![0]))).toEqual({ openings: 44, fridayMatches: 44, first3Matches: 43 });
      expect(one(original.replace(row('O31'), `O31,${shawn}`))).toEqual({ openings: 44, fridayMatches: 43, first3Matches: 43 });
      expect(one(original.replace(row('O32'), `${o32}; ${shawn}`))).toEqual({ openings: 44, fridayMatches: 43, first3Matches: 43 });
    },
    TIMEOUT,
  );
});

// ---- a Booked-style change through the library -----------------------------------------------------------

describe('4. rehearsal with a Booked change (Amanda, W42, booked into O34)', () => {
  it(
    'Amanda is off every list; every opening that changed is still a Friday match (replacements come from Tanya\'s list)',
    async () => {
      const AMANDA: BookedRecord = {
        personPhoneDigits: '5065550125',
        personName: 'Amanda Bourgeois',
        lineId: 'W42',
        openingId: 'O34',
        at: '2026-10-14T15:00:00.000Z',
        by: 'local',
      };
      const plain = await libraryRun();
      const booked = await libraryRun([AMANDA]);
      const ids = (out: RunOutput) => new Map(out.results.map((r) => [r.openingId, r.suggestions.map((s) => s.lineId)]));
      const before = ids(plain);
      const after = ids(booked);

      // Amanda was on some shortlists before, and is on none after (including O34, the one she was booked into).
      const hadAmanda = [...before].filter(([, l]) => l.includes('W42')).map(([id]) => id);
      expect(hadAmanda.length).toBeGreaterThan(0);
      expect(hadAmanda).toContain('O34');
      for (const [id, l] of after) expect(l, id).not.toContain('W42');

      const changed = [...before.keys()].filter((id) => before.get(id)!.join() !== after.get(id)!.join());
      // Only the openings that showed Amanda changed.
      expect(changed).toEqual(hadAmanda);
      console.log(`Booked Amanda (W42): ${changed.length} openings changed: ${changed.join(', ')}`);
      expect(changed).toEqual(['O01', 'O05', 'O11', 'O12', 'O18', 'O28', 'O32', 'O34', 'O35']);

      // Score the booked run's results.csv against the full sample key, through the CLI and in-process.
      const dir = freshDir('booked');
      const bookedResults = path.join(dir, 'results.csv');
      fs.writeFileSync(bookedResults, resultsCsv(booked.results), 'utf8');
      const key = parseAnswerKey(sampleText(KEY_FILE));
      const scored = scoreOpenings(parseResultsCsv(resultsCsv(booked.results)), key);

      // Removing a booked person never introduces a wrong name: all 44 are still Friday matches.
      expect(scored.totals.fridayMatches).toBe(44);
      for (const id of changed) {
        const s = scored.scores.find((x) => x.id === id)!;
        expect(s.fridayMatch, `${id}: ${s.problem}`).toBe(true);
        expect(s.ours.every((l) => s.theirs.includes(l)), id).toBe(true);
        // The others keep their order; a replacement (if any) is the next person on Tanya's list without Amanda.
        const tanyaWithoutAmanda = s.theirs.filter((l) => l !== 'W42');
        expect(s.ours, id).toEqual(tanyaWithoutAmanda.slice(0, 3));
      }
      // Unchanged openings are still exactly Tanya's first 3; changed ones cannot be (Amanda is on Tanya's list).
      for (const s of scored.scores) expect(s.first3Match, s.id).toBe(!changed.includes(s.id));
      expect(scored.totals.first3Matches).toBe(44 - changed.length);

      const res = score(bookedResults, KEY); // no line_verdicts.csv next to it: lines not scored
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain(`Openings: 44/44 match (Friday rule) · ${44 - changed.length}/44 equal Tanya's first 3`);
      expect(res.stdout).toContain('Lines: not scored (no line verdicts file)');
      expect(res.stdout).not.toContain('MISMATCH');
      expect(reportOf(res.stdout)).toBe(formatReport(scored, null));

      // A shorter list is fine: O18 (Tanya W20 W42) and O32 (Tanya W42 W49) now show one name each.
      expect(after.get('O18')).toEqual(['W20']);
      expect(after.get('O32')).toEqual(['W49']);
    },
    TIMEOUT,
  );
});

// ---- the scorer never writes -----------------------------------------------------------------------------

describe('5. the scorer never writes', () => {
  it(
    'after every score above (and one more), the run folder and data/sample/ are byte-identical to before',
    () => {
      // One more score in this test, so the check does not depend on the order the earlier tests ran in.
      const res = score(resultsPath(), KEY);
      expect(res.code, res.stderr).toBe(0);

      const runDirAfter = filesUnder(RUN_DIR);
      expect([...runDirAfter.keys()].sort()).toEqual(['line_verdicts.csv', 'results.csv', 'run.json']);
      expect(sameFiles(runDirAfter, runDirBefore), 'run folder unchanged').toBe(true);
      expect(sameFiles(filesUnder(SAMPLE), sampleBefore), 'data/sample/ unchanged').toBe(true);
      // The edited-results folders hold only what the tests wrote there (no report file, no verdicts copy).
      for (const entry of fs.readdirSync(TMP)) {
        if (/^(edited|booked)-\d+$/.test(entry)) expect(fs.readdirSync(path.join(TMP, entry)), entry).toEqual(['results.csv']);
        if (/^subset-key-\d+$/.test(entry)) expect(fs.readdirSync(path.join(TMP, entry)), entry).toEqual(['answer-key-friday.csv']);
      }
    },
    TIMEOUT,
  );
});
