// Integration: Features 1-4 end to end through the Friday command (scripts/shortlist.ts `run`), spawned for real,
// plus the same pipeline in-process (runShortlist) with a mocked Claude client.
// Expected behaviour: ../build-plan.md section 1 (Friday target: new files, no hand edits, no health details),
// section 6 Step 4 and section 7 (done checks); ../rules.md "Always" (same files in, same names out; test runs
// start with no Booked marks; never notes or health details).
// The CLI child never gets an ANTHROPIC_API_KEY (and never reads .env.local), so Claude is never called; the
// in-process runs use a mocked client. Sample files are never modified: every run works on temp copies.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Papa from 'papaparse';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { openRunCache } from '@/lib/cache-setup';
import { parseCsv, parseWaitlist } from '@/lib/csv';
import { groupLines } from '@/lib/import';
import { MAX_SUGGESTIONS, NO_SHOW_REASON, passingIds } from '@/lib/match';
import type { ReadingCacheEntry } from '@/lib/readings/cache';
import { readingKey } from '@/lib/readings/hash';
import { defaultReading } from '@/lib/readings/schema';
import { lineVerdictsCsv, resultsCsv, runShortlist } from '@/lib/run';
import type { RunOutput } from '@/lib/run';
import type { Reading } from '@/lib/types';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE = path.join(ROOT, 'data', 'sample');
const WAITLIST_FILE = 'waitlist-2026-10-21.csv';
const APPTS_FILE = 'appointments-2026-09-21-to-2026-10-17.csv';
const OPENINGS_FILE = 'late-openings-2026-09-21-to-2026-10-17.csv';
const sample = (f: string) => path.join(SAMPLE, f);
const sampleText = (f: string) => fs.readFileSync(sample(f), 'utf8');

const SAMPLE_RUN_DATE = '2026-10-21';
const FRIDAY_RUN_DATE = '2026-10-26';
const RUN_YEAR = 2026;
const TIMEOUT = 180_000;

// ---- nothing outside the temp dirs is touched ------------------------------------------------------------

const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(sample(f)));

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

/** The project's own output places: the top-level entries, runs/ (the CLI's default) and .data/ (its default cache). */
function projectSnapshot() {
  return {
    top: fs.readdirSync(ROOT).sort(),
    runs: filesUnder(path.join(ROOT, 'runs')),
    data: filesUnder(path.join(ROOT, '.data')),
  };
}
const sameFiles = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k)?.equals(v) === true);

let TMP = '';
let n = 0;
let before: ReturnType<typeof projectSnapshot>;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-cli-friday-'));
  before = projectSnapshot();
});
afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  // data/sample/ is byte-identical and holds the same files.
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(sample(f)).equals(bytes), f).toBe(true);
  expect(fs.readdirSync(SAMPLE).sort()).toEqual([...sampleBytes.keys()].sort());
  // Nothing was written to the project folder (no default runs/<date>/, no default .data cache, no stray file).
  const after = projectSnapshot();
  expect(after.top).toEqual(before.top);
  expect(sameFiles(after.runs, before.runs), 'runs/ unchanged').toBe(true);
  expect(sameFiles(after.data, before.data), '.data/ unchanged').toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'runs', FRIDAY_RUN_DATE))).toBe(false);
});

// ---- spawning the CLI (same approach as tests/unit/cli.test.ts) -----------------------------------------

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.SHORTLIST_SKIP_ENV_FILE = '1'; // never read a real key from .env.local
  return env;
}

// node runs tsx's own entry file, with no shell: the project folder has spaces, and npx.cmd needs a shell on Windows.
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

interface Box {
  dir: string;
  outDir: string;
  cache: string;
}
const box = (): Box => {
  const dir = path.join(TMP, `box-${++n}`);
  fs.mkdirSync(dir);
  return { dir, outDir: path.join(dir, 'run'), cache: path.join(dir, 'cache.json') };
};

interface Files {
  waitlist: string;
  appointments: string;
  openings: string;
}

const runArgs = (files: Files, runDate: string, b: Box) => [
  'run',
  '--waitlist', files.waitlist,
  '--appointments', files.appointments,
  '--openings', files.openings,
  '--run-date', runDate,
  '--out-dir', b.outDir,
  '--cache', b.cache,
];

const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

// ---- the Friday rehearsal files ------------------------------------------------------------------------

// (a) The sample waitlist plus three lines, as Tanya would type them (CRLF, like the sample file):
//  W61 a new person; W62 a repeat line for Andrea Pitre (W49) via "same #"; W63 "moved" for Lise Gautreau's phone (W57).
const NEW_PERSON = { id: 'W61', name: 'Odile Comeau', phone: '506-555-0199', notes: 'any - 60 - not Mon' };
const REPEAT = { id: 'W62', of: 'W49', name: 'Andrea Pitre', notes: 'still wants in - same as before' };
const MOVED = { id: 'W63', of: 'W57', name: 'Lise Gautreau', notes: 'moved to Halifax, take off' };
const EXTRA_WAITLIST = [
  `61,10/24,${NEW_PERSON.name},${NEW_PERSON.phone},${NEW_PERSON.notes}`,
  `62,10/24,Andrea P.,same #,${REPEAT.notes}`,
  `63,10/25,Lise G.,506-555-0144,"${MOVED.notes}"`,
];
const CHANGED_NEWEST = [REPEAT.id, MOVED.id, NEW_PERSON.id];

// (c) The sample booking export plus two bookings made after Oct 21 for Shawn Duguay (W46, full name).
const BOOKED_SINCE = { id: 'W46', name: 'Shawn Duguay', reason: 'Booked since: Oct 22 as Shawn Duguay.' };
const EXTRA_APPOINTMENTS = [
  'A-24601,2026-10-23,10:00,11:00,60,Massage therapy 60 min,Dave Melanson,K-3412,Shawn Duguay,2026-10-22 09:14,phone,text C,Completed,,,,,',
  'A-24602,2026-10-24,13:00,14:00,60,Massage therapy 60 min,Marc Cormier,K-3412,Shawn Duguay,2026-10-23 11:02,online,text C,Completed,,,,,',
];

// (b) Ten new openings, Mon Oct 26 to Sat Oct 31, in date order. Two no-shows (O02, O08), one Josée (O10),
// one 90-min Kelsey (O03), one 1-hour notice (O04). hours_notice = start - cancelled_at.
const OPENING_COLUMNS = [
  'opening_id', 'appointment_id', 'date', 'day', 'start', 'length_min', 'therapist', 'kind', 'cancelled_at',
  'hours_notice', 'heard_via', 'client_had_confirmed', 'refilled', 'refilled_how', 'booked_value_cad',
];
const OPENINGS: string[][] = [
  ['O01', 'A-25004', '2026-10-26', 'Mon', '10:00', '60', 'Dave Melanson', 'late cancel', '2026-10-26 06:42', '3.3', 'voicemail (overnight)', 'yes (text)', 'no', '', '115'],
  ['O02', 'A-25013', '2026-10-26', 'Mon', '14:00', '60', 'Amira Haddad', 'no-show', '2026-10-26 14:15', '0.0', 'no-show', 'no', 'no', '', '115'],
  ['O03', 'A-25031', '2026-10-27', 'Tue', '11:00', '90', 'Kelsey Babineau', 'late cancel', '2026-10-27 07:30', '3.5', 'voicemail (overnight)', 'yes (text)', 'no', '', '160'],
  ['O04', 'A-25042', '2026-10-27', 'Tue', '17:00', '60', 'Rachel Thibodeau', 'late cancel', '2026-10-27 16:00', '1.0', 'phone', 'yes (phone)', 'no', '', '115'],
  ['O05', 'A-25056', '2026-10-28', 'Wed', '11:15', '60', 'Amira Haddad', 'late cancel', '2026-10-28 08:05', '3.2', 'morning call', 'yes (text)', 'no', '', '115'],
  ['O06', 'A-25067', '2026-10-29', 'Thu', '16:30', '60', 'Dave Melanson', 'late cancel', '2026-10-29 12:00', '4.5', 'text reply', 'yes (text)', 'no', '', '115'],
  ['O07', 'A-25071', '2026-10-29', 'Thu', '12:00', '30', 'Marc Cormier', 'late cancel', '2026-10-29 08:30', '3.5', 'online (Kneadly)', 'no', 'no', '', '70'],
  ['O08', 'A-25083', '2026-10-30', 'Fri', '15:00', '60', 'Kelsey Babineau', 'no-show', '2026-10-30 15:15', '0.0', 'no-show', 'yes (text)', 'no', '', '115'],
  ['O09', 'A-25090', '2026-10-30', 'Fri', '18:00', '60', 'Rachel Thibodeau', 'late cancel', '2026-10-30 11:20', '6.7', 'phone', 'yes (text)', 'no', '', '115'],
  ['O10', 'A-25102', '2026-10-31', 'Sat', '13:00', '60', 'Josée Landry', 'late cancel', '2026-10-31 10:30', '2.5', 'morning call', 'yes (text)', 'no', '', '115'],
];
const OPENING_IDS = OPENINGS.map((o) => o[0]!);
const NO_SHOWS = OPENINGS.filter((o) => o[7] === 'no-show').map((o) => o[0]!);

function openingsCsv(columns: string[] = OPENING_COLUMNS): string {
  const rows = OPENINGS.map((o) => Object.fromEntries(OPENING_COLUMNS.map((c, i) => [c, o[i]!])));
  return `${Papa.unparse(rows, { columns, newline: '\r\n' })}\r\n`;
}

/** Writes the three rehearsal files (new names, as a Friday hand-over would have) into a fresh folder. */
function rehearsalFiles(opts: { openingColumns?: string[] } = {}): Files {
  const dir = path.join(TMP, `inputs-${++n}`);
  fs.mkdirSync(dir);
  const files: Files = {
    waitlist: path.join(dir, 'waitlist-2026-10-26.csv'),
    appointments: path.join(dir, 'appointments-2026-09-21-to-2026-10-25.csv'),
    openings: path.join(dir, 'late-openings-2026-10-26-to-2026-10-31.csv'),
  };
  fs.writeFileSync(files.waitlist, sampleText(WAITLIST_FILE) + EXTRA_WAITLIST.map((r) => `${r}\r\n`).join(''), 'utf8');
  fs.writeFileSync(files.appointments, sampleText(APPTS_FILE) + EXTRA_APPOINTMENTS.map((r) => `${r}\r\n`).join(''), 'utf8');
  fs.writeFileSync(files.openings, openingsCsv(opts.openingColumns), 'utf8');
  return files;
}

const textsOf = (f: Files) => ({
  waitlistText: fs.readFileSync(f.waitlist, 'utf8'),
  appointmentsText: fs.readFileSync(f.appointments, 'utf8'),
  openingsText: fs.readFileSync(f.openings, 'utf8'),
});

// ---- reading the CLI's output files --------------------------------------------------------------------

interface ShortlistRow {
  openingId: string;
  shortlist: string;
  /** Line ids shown, in the order shown. */
  ids: string[];
}
function parseResults(text: string): ShortlistRow[] {
  return parseCsv(text).map((r) => ({
    openingId: r.opening_id!,
    shortlist: r.shortlist!,
    ids: r.shortlist === 'none' ? [] : r.shortlist!.split('; ').map((s) => s.split(' ')[0]!),
  }));
}
function parseVerdicts(text: string): Record<string, { verdict: string; reason: string }> {
  return Object.fromEntries(parseCsv(text).map((r) => [r.line!, { verdict: r.verdict!, reason: r.reason! }]));
}
const lineNo = (id: string) => Number(id.slice(1));

// ---- one shared CLI rehearsal run (tests 2, 4 and 6 read it) ------------------------------------------

interface CliRun {
  files: Files;
  box: Box;
  code: number | null;
  stdout: string;
  stderr: string;
}
let rehearsal: CliRun | null = null;
function cliRehearsal(): CliRun {
  if (!rehearsal) {
    const files = rehearsalFiles();
    const b = box();
    rehearsal = { files, box: b, ...cli(runArgs(files, FRIDAY_RUN_DATE, b)) };
  }
  return rehearsal;
}

// ---- mocked Anthropic client (same pattern as import-and-read.test.ts) ---------------------------------

function message(text: string): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  } as unknown as BetaMessage;
}

/** Line ids in the user message of a request, in order. */
function idsIn(p: MessageCreateParamsNonStreaming): string[] {
  return [...String(p.messages[0]!.content).matchAll(/"lineId": "(W\d+)"/g)].map((m) => m[1]!);
}

/** A client whose reply is chosen by the line ids it was sent. An unexpected group fails the run. */
function mockClient(replies: Record<string, unknown>) {
  const calls: string[] = [];
  const create = vi.fn(async (p: MessageCreateParamsNonStreaming) => {
    const ids = idsIn(p).join(',');
    calls.push(ids);
    if (!(ids in replies)) throw new Error(`unexpected Claude call for ${ids}`);
    return message(JSON.stringify(replies[ids]));
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create, calls };
}

/** The saved sample reading of one sample person, found by that person's newest sample line. */
function savedReading(newestId: string): Reading {
  const saved = JSON.parse(sampleText('readings.json')) as Record<string, ReadingCacheEntry>;
  const group = groupLines(parseWaitlist(sampleText(WAITLIST_FILE), RUN_YEAR)).find((g) => g[g.length - 1]!.id === newestId)!;
  const entry = saved[readingKey(group, RUN_YEAR)];
  if (!entry) throw new Error(`no saved reading for ${newestId}`);
  return structuredClone(entry.reading);
}

/** Valid readings for the three new/changed groups. Every quote is in that group's notes. */
function changedReadings(): Record<string, Reading> {
  const odile = defaultReading();
  odile.lengths = { value: { minutes: [60], only: false }, source: [{ lineId: 'W61', text: '60' }] };
  odile.daysExcluded = { value: ['Mon'], source: [{ lineId: 'W61', text: 'not Mon' }] };

  const andrea = savedReading(REPEAT.of); // W62 adds nothing new: "still wants in - same as before"

  const lise = savedReading(MOVED.of);
  lise.gone = { value: 'moved', source: [{ lineId: MOVED.id, text: 'moved to Halifax' }] };

  return { W61: odile, [`${REPEAT.of},${REPEAT.id}`]: andrea, [`${MOVED.of},${MOVED.id}`]: lise };
}

// =========================================================================================================

describe('1. CLI = library', () => {
  it(
    "the CLI's results.csv and line_verdicts.csv for the sample equal resultsCsv / lineVerdictsCsv of runShortlist",
    async () => {
      const b = box();
      const files: Files = { waitlist: sample(WAITLIST_FILE), appointments: sample(APPTS_FILE), openings: sample(OPENINGS_FILE) };
      const res = cli(runArgs(files, SAMPLE_RUN_DATE, b));
      expect(res.code, res.stderr).toBe(0);

      const lib = await runShortlist({
        ...textsOf(files),
        runDate: SAMPLE_RUN_DATE,
        cache: openRunCache(path.join(b.dir, 'library-cache.json')),
        client: null,
      });
      expect(read(b.outDir, 'results.csv')).toBe(resultsCsv(lib.results));
      expect(read(b.outDir, 'line_verdicts.csv')).toBe(lineVerdictsCsv(lib.lines, lib.verdicts, lib.reasons));
      expect(JSON.parse(read(b.outDir, 'run.json')).summary).toEqual(lib.summary);
      // Sanity: it is the real sample run (44 openings, 60 lines).
      expect(lib.results).toHaveLength(44);
      expect(lib.lines).toHaveLength(60);
    },
    TIMEOUT,
  );
});

describe('2. Friday-style rehearsal on new files, no hand edits (CLI, no Claude key)', () => {
  it(
    'exit 0; 10 rows in input order; no-shows none; booked-since and moved never offered; changed groups not read',
    () => {
      const run = cliRehearsal();
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toBe('');

      // The run folder holds exactly the three files.
      expect(fs.readdirSync(run.box.outDir).sort()).toEqual(['line_verdicts.csv', 'results.csv', 'run.json']);

      // results.csv: header + exactly 10 data rows, in the openings file's order.
      const resultsText = read(run.box.outDir, 'results.csv');
      expect(resultsText.split('\n')[0]).toBe('opening_id,shortlist');
      const rows = parseResults(resultsText);
      expect(rows).toHaveLength(10);
      expect(rows.map((r) => r.openingId)).toEqual(OPENING_IDS);

      // No-shows are "none".
      for (const id of NO_SHOWS) expect(rows.find((r) => r.openingId === id)!.shortlist, id).toBe('none');

      // At most 3 names, ascending newest-line number, each "Wnn Name (506-555-0000)".
      for (const r of rows) {
        expect(r.ids.length, r.openingId).toBeLessThanOrEqual(MAX_SUGGESTIONS);
        expect(r.ids, r.openingId).toEqual([...r.ids].sort((a, b) => lineNo(a) - lineNo(b)));
        expect(new Set(r.ids).size, r.openingId).toBe(r.ids.length);
        if (r.shortlist !== 'none') {
          for (const s of r.shortlist.split('; ')) expect(s, r.openingId).toMatch(/^W\d{2} [^()]+ \(\d{3}-\d{3}-\d{4}\)$/);
        }
      }
      // The run is not trivially empty: some openings do have people.
      expect(rows.filter((r) => r.ids.length > 0).length).toBeGreaterThan(0);

      // Nobody tagged or unread is offered: not the booked-since person, not the moved person, not the 3 changed groups.
      const shown = new Set(rows.flatMap((r) => r.ids));
      for (const id of [BOOKED_SINCE.id, MOVED.id, MOVED.of, REPEAT.id, REPEAT.of, NEW_PERSON.id]) {
        expect(shown.has(id), id).toBe(false);
      }
      for (const name of [BOOKED_SINCE.name, MOVED.name, REPEAT.name, NEW_PERSON.name]) {
        expect(resultsText, name).not.toContain(name);
      }

      // line_verdicts.csv: one row per line W01..W63, in line order.
      const verdictsText = read(run.box.outDir, 'line_verdicts.csv');
      const verdictIds = parseCsv(verdictsText).map((r) => r.line);
      expect(verdictIds).toEqual(Array.from({ length: 63 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`));
      const v = parseVerdicts(verdictsText);

      // The booked-since person (from the newer booking export) is stale with the reason.
      expect(v[BOOKED_SINCE.id]).toEqual({ verdict: 'stale', reason: BOOKED_SINCE.reason });

      // The moved person: with no Claude key their changed group is not read, so nothing has read "moved" yet.
      // They are never offered (above) and are named in the warning (below), but their line verdicts cannot say
      // stale until Claude reads the line (test 3). Their newest line's reason says they were not offered.
      const NOT_READ = 'Notes not read yet, so not offered.';
      expect(v[MOVED.id]).toEqual({ verdict: 'active', reason: NOT_READ });
      expect(v[MOVED.of]).toEqual({ verdict: `duplicate of ${MOVED.id}`, reason: '' });
      expect(v[REPEAT.id]).toEqual({ verdict: 'active', reason: NOT_READ });
      expect(v[REPEAT.of]).toEqual({ verdict: `duplicate of ${REPEAT.id}`, reason: '' });
      expect(v[NEW_PERSON.id]).toEqual({ verdict: 'active', reason: NOT_READ });

      // The three new/changed groups are reported as not read, by their newest line ids.
      expect(run.stdout).toContain('WARNING: 3 people were not read');
      for (const id of CHANGED_NEWEST) expect(run.stdout, id).toContain(id);
      expect(run.stdout).toContain('3 not read');
      expect(run.stdout).toContain('not offered');
      const runJson = JSON.parse(read(run.box.outDir, 'run.json')) as Record<string, any>;
      expect([...runJson.summary.notRead].sort()).toEqual([...CHANGED_NEWEST].sort());
      expect(runJson.summary).toMatchObject({ openings: 10, noShows: 2, linesRead: 63, failed: [] });
      expect(runJson.readings).toEqual({ read: 43, notRead: 3, failed: 0 });
      expect(runJson.runDate).toBe(FRIDAY_RUN_DATE);
      expect(runJson.inputs.waitlist.file).toBe('waitlist-2026-10-26.csv');
      expect(runJson.inputs.openings.file).toBe('late-openings-2026-10-26-to-2026-10-31.csv');

      // The inputs were only read: the rehearsal files are unchanged on disk.
      const fresh = rehearsalFiles();
      for (const k of ['waitlist', 'appointments', 'openings'] as const) {
        expect(fs.readFileSync(run.files[k]).equals(fs.readFileSync(fresh[k])), k).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    'without the newer booking export and the moved line, those two people would have been offered (so the test bites)',
    async () => {
      const files = rehearsalFiles();
      const t = textsOf(files);
      const { client } = mockClient(changedReadings());
      const stripped = {
        waitlistText: t.waitlistText.replace(EXTRA_WAITLIST[2]! + '\r\n', ''),
        appointmentsText: sampleText(APPTS_FILE),
        openingsText: t.openingsText,
      };
      const out = await runShortlist({ ...stripped, runDate: FRIDAY_RUN_DATE, cache: openRunCache(path.join(box().dir, 'c.json')), client });
      const shown = new Set(out.results.flatMap((r) => r.suggestions.map((s) => s.lineId)));
      expect(shown.has(BOOKED_SINCE.id)).toBe(true);
      expect(shown.has(MOVED.of)).toBe(true);
    },
    TIMEOUT,
  );
});

describe('3. the same rehearsal with Claude (mocked), in-process', () => {
  it(
    'exactly 3 calls; moved is stale; the new person is suggested where they fit, after everyone earlier; rerun makes 0 calls',
    async () => {
      const files = rehearsalFiles();
      const cachePath = path.join(box().dir, 'cache.json');
      const { client, create, calls } = mockClient(changedReadings());
      const input = { ...textsOf(files), runDate: FRIDAY_RUN_DATE, client };

      const first: RunOutput = await runShortlist({ ...input, cache: openRunCache(cachePath) });
      expect(create).toHaveBeenCalledTimes(3);
      expect([...calls].sort()).toEqual(['W49,W62', 'W57,W63', 'W61']);
      for (const id of CHANGED_NEWEST) expect(first.reads.get(id), id).toMatchObject({ status: 'claude', problems: [] });
      expect(first.summary.notRead).toEqual([]);
      expect(first.summary.failed).toEqual([]);

      // The moved person is stale on both lines, with the reason; the booked-since person too.
      expect(first.verdicts[MOVED.id]).toBe('stale');
      expect(first.verdicts[MOVED.of]).toBe('stale');
      expect(first.reasons[MOVED.id]).toBe('Moved away.');
      expect(first.reasons[MOVED.of]).toBe('Moved away.');
      expect(first.verdicts[BOOKED_SINCE.id]).toBe('stale');
      expect(first.reasons[BOOKED_SINCE.id]).toBe(BOOKED_SINCE.reason);
      // The repeat line is merged into Andrea's person; the new person is active.
      expect(first.verdicts[REPEAT.of]).toBe(`duplicate of ${REPEAT.id}`);
      expect(first.verdicts[REPEAT.id]).toBe('active');
      expect(first.verdicts[NEW_PERSON.id]).toBe('active');

      const shown = first.results.flatMap((r) => r.suggestions.map((s) => s.lineId));
      for (const id of [BOOKED_SINCE.id, MOVED.id, MOVED.of]) expect(shown, id).not.toContain(id);

      // No-shows are nobody; every shortlist is at most 3, ascending; and it is exactly the first 3 that pass.
      for (const r of first.results) {
        if (NO_SHOWS.includes(r.openingId)) expect(r.nobodyReason, r.openingId).toBe(NO_SHOW_REASON);
        const ids = r.suggestions.map((s) => s.lineId);
        expect(ids.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
        expect(ids, r.openingId).toEqual([...ids].sort((a, b) => lineNo(a) - lineNo(b)));
        expect(ids, r.openingId).toEqual(passingIds(r).slice(0, MAX_SUGGESTIONS));
      }

      // The new person (W61, "any - 60 - not Mon"): offered only where they pass and fewer than 3 people with an
      // earlier newest line also pass; then they are last. Never on a Monday.
      const w61Shown = first.results.filter((r) => r.suggestions.some((s) => s.lineId === NEW_PERSON.id));
      expect(w61Shown.map((r) => r.openingId)).toContain('O10');
      for (const r of first.results) {
        const passing = passingIds(r);
        const ids = r.suggestions.map((s) => s.lineId);
        if (!passing.includes(NEW_PERSON.id)) {
          expect(ids, r.openingId).not.toContain(NEW_PERSON.id);
          continue;
        }
        const earlier = passing.filter((id) => lineNo(id) < 61);
        if (earlier.length >= MAX_SUGGESTIONS) {
          expect(ids, r.openingId).not.toContain(NEW_PERSON.id);
        } else {
          expect(ids.slice(0, earlier.length), r.openingId).toEqual(earlier);
          expect(ids[earlier.length], r.openingId).toBe(NEW_PERSON.id);
        }
      }
      for (const id of ['O01', 'O02']) {
        expect(passingIds(first.results.find((r) => r.openingId === id)!), id).not.toContain(NEW_PERSON.id);
      }

      // Second run on the same cache file: no calls, identical hand-in CSVs.
      const second = await runShortlist({ ...input, cache: openRunCache(cachePath) });
      expect(create).toHaveBeenCalledTimes(3);
      for (const id of CHANGED_NEWEST) expect(second.reads.get(id)!.status, id).toBe('cached');
      expect(resultsCsv(second.results)).toBe(resultsCsv(first.results));
      expect(lineVerdictsCsv(second.lines, second.verdicts, second.reasons)).toBe(
        lineVerdictsCsv(first.lines, first.verdicts, first.reasons),
      );
      expect(second.summary).toEqual(first.summary);
    },
    TIMEOUT,
  );
});

describe('4. determinism (CLI)', () => {
  it(
    'two CLI runs on the rehearsal files: byte-identical results.csv and line_verdicts.csv; run.json differs only in createdAt',
    () => {
      const a = cliRehearsal();
      expect(a.code, a.stderr).toBe(0);
      const b = box();
      const second = cli(runArgs(a.files, FRIDAY_RUN_DATE, b)); // same input files, fresh cache and folder
      expect(second.code, second.stderr).toBe(0);
      for (const f of ['results.csv', 'line_verdicts.csv']) {
        expect(fs.readFileSync(path.join(b.outDir, f)).equals(fs.readFileSync(path.join(a.box.outDir, f))), f).toBe(true);
      }
      const ja = JSON.parse(read(a.box.outDir, 'run.json')) as Record<string, unknown>;
      const jb = JSON.parse(read(b.outDir, 'run.json')) as Record<string, unknown>;
      expect(typeof ja.createdAt).toBe('string');
      expect(typeof jb.createdAt).toBe('string');
      const { createdAt: _a, ...restA } = ja;
      const { createdAt: _b, ...restB } = jb;
      expect(restB).toEqual(restA);
      const strip = (dir: string) => read(dir, 'run.json').replace(/"createdAt": "[^"]*"/, '"createdAt": ""');
      expect(strip(b.outDir)).toBe(strip(a.box.outDir));
    },
    TIMEOUT,
  );
});

describe('5. bad input refuses cleanly', () => {
  it(
    'an openings file missing hours_notice: exit 1, stderr names the file and the column, no run folder files',
    () => {
      const files = rehearsalFiles({ openingColumns: OPENING_COLUMNS.filter((c) => c !== 'hours_notice') });
      expect(fs.readFileSync(files.openings, 'utf8').split('\r\n')[0]).not.toContain('hours_notice');
      const b = box();
      const res = cli(runArgs(files, FRIDAY_RUN_DATE, b));
      expect(res.code).toBe(1);
      expect(res.stderr).toContain(path.basename(files.openings));
      expect(res.stderr).toContain('late openings file');
      expect(res.stderr).toContain('hours_notice');
      expect(res.stderr).not.toContain('Usage'); // a file problem, not an argument problem
      // The column check runs before anything is written: the run folder is never created.
      expect(fs.existsSync(path.join(b.outDir, 'results.csv'))).toBe(false);
      expect(fs.existsSync(path.join(b.outDir, 'line_verdicts.csv'))).toBe(false);
      expect(fs.existsSync(path.join(b.outDir, 'run.json'))).toBe(false);
      expect(fs.existsSync(b.outDir)).toBe(false);
    },
    TIMEOUT,
  );
});

describe('6. no health details in any output file', () => {
  const HEALTH = [
    'pregnant', 'pregnancy', 'surgery', 'post-op', 'MVA', 'sciatica', 'cancer', 'fibro', 'concussion', 'migraine',
    'TMJ', 'knee', 'hip', 'hamstring', 'rotator',
  ];
  const healthRe = new RegExp(`(?<![A-Za-z0-9])(${HEALTH.map((w) => w.replace('-', '\\-')).join('|')})(?![A-Za-z0-9])`, 'i');

  function expectClean(label: string, text: string, notes: string[]) {
    expect(text.match(healthRe)?.[0] ?? null, `${label}: health word`).toBeNull();
    for (const note of notes) expect(text.includes(note), `${label}: contains the note "${note}"`).toBe(false);
  }

  it(
    'results.csv, line_verdicts.csv and run.json from the CLI rehearsal (and the Claude-read CSVs) carry no health words or notes',
    async () => {
      const run = cliRehearsal();
      expect(run.code, run.stderr).toBe(0);
      const notes = parseWaitlist(fs.readFileSync(run.files.waitlist, 'utf8'), RUN_YEAR)
        .map((l) => l.notes.trim())
        .filter((t) => t !== '');
      expect(notes).toHaveLength(63);
      // The scan would catch a leak: the waitlist itself trips it.
      expect(healthRe.test(fs.readFileSync(run.files.waitlist, 'utf8'))).toBe(true);

      for (const f of ['results.csv', 'line_verdicts.csv', 'run.json']) expectClean(f, read(run.box.outDir, f), notes);

      // The Claude-read run writes reasons such as "Moved away." into line_verdicts.csv: still no notes.
      const { client } = mockClient(changedReadings());
      const out = await runShortlist({
        ...textsOf(run.files),
        runDate: FRIDAY_RUN_DATE,
        cache: openRunCache(path.join(box().dir, 'cache.json')),
        client,
      });
      expectClean('results.csv (Claude)', resultsCsv(out.results), notes);
      expectClean('line_verdicts.csv (Claude)', lineVerdictsCsv(out.lines, out.verdicts, out.reasons), notes);
      expectClean('summary (Claude)', JSON.stringify(out.summary), notes);
    },
    TIMEOUT,
  );
});
