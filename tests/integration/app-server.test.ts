// Integration: Features 1-6a through the server side of the app. The route handlers (POST /api/import,
// GET /api/admin, /api/state, /api/line-verdicts.csv) are called directly with Request objects; the store, the
// current run and the import service are called in-process. No dev server is used or started.
// Expected behaviour: ../build-plan.md section 4 "Keeping the backend in sync (Booked)" (save first then show;
// everything reads the same records; one booking per opening; undo; booked rows survive a new waitlist import and
// hold until the person has a newer line; test runs use their own empty store), section 6 (Admin, B5) and
// section 7 (done checks); ../rules.md Step 2 ("Tanya filled an opening with them") and "Always".
// Every test gets its own empty SHORTLIST_DATA_DIR and SHORTLIST_NO_CLAUDE=1; where Claude must read a changed
// group, the import service is given a mocked client. The real API is never called and data/sample/ is only read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Papa from 'papaparse';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { POST as importPOST } from '@/app/api/import/route';
import { GET as adminGET } from '@/app/api/admin/route';
import { GET as stateGET } from '@/app/api/state/route';
import { GET as verdictsGET } from '@/app/api/line-verdicts.csv/route';
import { openRunCache } from '@/lib/cache-setup';
import { parseWaitlist } from '@/lib/csv';
import { CLINIC_RULE_SOURCE } from '@/lib/format';
import { groupLines } from '@/lib/import';
import { MAX_SUGGESTIONS, passingIds } from '@/lib/match';
import type { ReadingCacheEntry } from '@/lib/readings/cache';
import { readingKey } from '@/lib/readings/hash';
import { defaultReading } from '@/lib/readings/schema';
import { lineVerdictsCsv, resultsCsv, runShortlist } from '@/lib/run';
import type { RunOutput } from '@/lib/run';
import { LocalStore, getStore } from '@/lib/storage';
import type { Store } from '@/lib/storage';
import { getCurrentRun } from '@/lib/server/current';
import { importFiles } from '@/lib/server/import-service';
import type { ImportInput } from '@/lib/server/import-service';
import type { AdminView } from '@/lib/server/views';
import type { BookedRecord, Reading } from '@/lib/types';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE = path.join(ROOT, 'data', 'sample');
const NAMES = {
  waitlist: 'waitlist-2026-10-21.csv',
  openings: 'late-openings-2026-09-21-to-2026-10-17.csv',
  appointments: 'appointments-2026-09-21-to-2026-10-17.csv',
} as const;
const sampleText = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');
const SAMPLE_RUN_DATE = '2026-10-21';
const FRIDAY_RUN_DATE = '2026-10-26';
const RUN_YEAR = 2026;
const TIMEOUT = 120_000;

type Kind = 'waitlist' | 'openings' | 'appointments';
type Files = Record<Kind, { name: string; text: string }>;

const sampleFiles = (): Files => ({
  waitlist: { name: NAMES.waitlist, text: sampleText(NAMES.waitlist) },
  openings: { name: NAMES.openings, text: sampleText(NAMES.openings) },
  appointments: { name: NAMES.appointments, text: sampleText(NAMES.appointments) },
});

/** The sample waitlist plus rows typed the way the sample is (CRLF line ends). */
const withRows = (text: string, rows: string[]) => text + rows.map((r) => `${r}\r\n`).join('');

// ---- nothing outside the temp dirs is touched ------------------------------------------------------------

const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(path.join(SAMPLE, f)));
const topBefore = fs.readdirSync(ROOT).sort();

let TMP = '';
let n = 0;
let dir = '';
const env = { data: process.env.SHORTLIST_DATA_DIR, noClaude: process.env.SHORTLIST_NO_CLAUDE, key: process.env.ANTHROPIC_API_KEY };

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-app-server-'));
  process.env.SHORTLIST_NO_CLAUDE = '1';
});
// A fresh, empty store folder for every test (build-plan section 4: test runs use their own empty store).
beforeEach(() => {
  dir = path.join(TMP, `store-${++n}`);
  process.env.SHORTLIST_DATA_DIR = dir;
  process.env.SHORTLIST_NO_CLAUDE = '1';
});
afterAll(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('SHORTLIST_DATA_DIR', env.data);
  restore('SHORTLIST_NO_CLAUDE', env.noClaude);
  restore('ANTHROPIC_API_KEY', env.key);
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(path.join(SAMPLE, f)).equals(bytes), f).toBe(true);
  expect(fs.readdirSync(SAMPLE).sort()).toEqual([...sampleBytes.keys()].sort());
  expect(fs.readdirSync(ROOT).sort()).toEqual(topBefore);
});

// ---- calling the routes ------------------------------------------------------------------------------------

function importRequest(files: Files, runDate: string): Request {
  const form = new FormData();
  for (const kind of ['waitlist', 'openings', 'appointments'] as const) {
    form.append(kind, new File([files[kind].text], files[kind].name, { type: 'text/csv' }));
  }
  form.append('runDate', runDate);
  return new Request('http://localhost/api/import', { method: 'POST', body: form });
}

async function postImport(files: Files, runDate = SAMPLE_RUN_DATE): Promise<{ status: number; body: any }> {
  const res = await importPOST(importRequest(files, runDate));
  return { status: res.status, body: await res.json() };
}

async function postOk(files: Files, runDate = SAMPLE_RUN_DATE): Promise<any> {
  const { status, body } = await postImport(files, runDate);
  expect(status, body.message).toBe(200);
  expect(body.ok).toBe(true);
  return body;
}

const admin = async (): Promise<AdminView> => (await adminGET()).json();
const state = async (): Promise<{ version: number; import: any }> => (await stateGET()).json();
async function verdictsText(): Promise<string> {
  const res = await verdictsGET();
  expect(res.status).toBe(200);
  return res.text();
}

async function currentRun(store: Store = getStore()): Promise<RunOutput> {
  const run = await getCurrentRun(store);
  if (!run) throw new Error('no current run');
  return run;
}

const shownIds = (run: RunOutput) => run.results.flatMap((r) => r.suggestions.map((s) => s.lineId));
const shownNames = (run: RunOutput) => run.results.flatMap((r) => r.suggestions.map((s) => s.name));
const lineNo = (id: string) => Number(id.slice(1));

// ---- Amanda Bourgeois: W26 + W42, same phone (O34's answer key names her) ----------------------------------

const AMANDA = { name: 'Amanda Bourgeois', digits: '5065550125', lines: ['W26', 'W42'], newest: 'W42' };

function booking(over: Partial<BookedRecord> = {}): BookedRecord {
  return {
    personPhoneDigits: AMANDA.digits,
    personName: AMANDA.name,
    lineId: AMANDA.newest,
    openingId: 'O34',
    at: '2026-10-21T14:30:00.000Z',
    by: 'local',
    ...over,
  };
}

/** True when Amanda (any of her line ids, or her name) is a suggestion anywhere in the run. */
const amandaShown = (run: RunOutput, ids: string[] = AMANDA.lines) =>
  shownIds(run).some((id) => ids.includes(id)) || shownNames(run).includes(AMANDA.name);

// ---- mocked Anthropic client (same pattern as import-and-read.test.ts / cli-friday.test.ts) ----------------

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

function idsIn(p: MessageCreateParamsNonStreaming): string[] {
  return [...String(p.messages[0]!.content).matchAll(/"lineId": "(W\d+)"/g)].map((m) => m[1]!);
}

/** A client whose reply is chosen by the line ids it was sent. An unexpected group fails that read. */
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
  const group = groupLines(parseWaitlist(sampleText(NAMES.waitlist), RUN_YEAR)).find((g) => g[g.length - 1]!.id === newestId)!;
  const entry = saved[readingKey(group, RUN_YEAR)];
  if (!entry) throw new Error(`no saved reading for ${newestId}`);
  return structuredClone(entry.reading);
}

// ---- the Friday rehearsal files (as built in cli-friday.test.ts) -------------------------------------------

const NEW_PERSON = { id: 'W61', name: 'Odile Comeau', phone: '506-555-0199', notes: 'any - 60 - not Mon' };
const REPEAT = { id: 'W62', of: 'W49', name: 'Andrea Pitre', notes: 'still wants in - same as before' };
const MOVED = { id: 'W63', of: 'W57', name: 'Lise Gautreau', notes: 'moved to Halifax, take off' };
const EXTRA_WAITLIST = [
  `61,10/24,${NEW_PERSON.name},${NEW_PERSON.phone},${NEW_PERSON.notes}`,
  `62,10/24,Andrea P.,same #,${REPEAT.notes}`,
  `63,10/25,Lise G.,506-555-0144,"${MOVED.notes}"`,
];
const CHANGED_NEWEST = [REPEAT.id, MOVED.id, NEW_PERSON.id];
const BOOKED_SINCE = { id: 'W46', name: 'Shawn Duguay', reason: 'Booked since: Oct 22 as Shawn Duguay.' };
const EXTRA_APPOINTMENTS = [
  'A-24601,2026-10-23,10:00,11:00,60,Massage therapy 60 min,Dave Melanson,K-3412,Shawn Duguay,2026-10-22 09:14,phone,text C,Completed,,,,,',
  'A-24602,2026-10-24,13:00,14:00,60,Massage therapy 60 min,Marc Cormier,K-3412,Shawn Duguay,2026-10-23 11:02,online,text C,Completed,,,,,',
];
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

function rehearsalFiles(): Files {
  const rows = OPENINGS.map((o) => Object.fromEntries(OPENING_COLUMNS.map((c, i) => [c, o[i]!])));
  return {
    waitlist: { name: 'waitlist-2026-10-26.csv', text: withRows(sampleText(NAMES.waitlist), EXTRA_WAITLIST) },
    appointments: {
      name: 'appointments-2026-09-21-to-2026-10-25.csv',
      text: withRows(sampleText(NAMES.appointments), EXTRA_APPOINTMENTS),
    },
    openings: {
      name: 'late-openings-2026-10-26-to-2026-10-31.csv',
      text: `${Papa.unparse(rows, { columns: OPENING_COLUMNS, newline: '\r\n' })}\r\n`,
    },
  };
}

// ---- privacy scan -------------------------------------------------------------------------------------------

const HEALTH = [
  'pregnant', 'pregnancy', 'surgery', 'post-op', 'MVA', 'sciatica', 'cancer', 'fibro', 'concussion', 'migraine',
  'TMJ', 'knee', 'hip', 'hamstring', 'rotator', 'shoulder',
];
const healthRe = new RegExp(`(?<![A-Za-z0-9])(${HEALTH.map((w) => w.replace('-', '\\-')).join('|')})(?![A-Za-z0-9])`, 'gi');
const healthHits = (text: string) => [...new Set([...text.matchAll(healthRe)].map((m) => m[0]))];

/** Every string anywhere inside a JSON value (keys too). */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsIn(v, out);
    }
  }
  return out;
}

// =============================================================================================================

describe('1. screens agree with the CLI', () => {
  it(
    'POST /api/import (sample) -> /api/line-verdicts.csv and the current run equal runShortlist on the same files',
    async () => {
      const files = sampleFiles();
      const body = await postOk(files);
      expect(body.view.counts).toEqual({ linesRead: 60, peopleReady: 30, repeatLinesMerged: 10, staleLines: 20, notRead: 0 });

      const lib = await runShortlist({
        waitlistText: files.waitlist.text,
        openingsText: files.openings.text,
        appointmentsText: files.appointments.text,
        runDate: SAMPLE_RUN_DATE,
        cache: openRunCache(path.join(TMP, `lib-cache-${++n}.json`)),
        client: null,
      });
      expect(lib.results).toHaveLength(44);

      expect(await verdictsText()).toBe(lineVerdictsCsv(lib.lines, lib.verdicts, lib.reasons));
      const run = await currentRun();
      expect(resultsCsv(run.results)).toBe(resultsCsv(lib.results));
      expect(run.summary).toEqual(lib.summary);
      // The admin view's counts come from the same run.
      const view = await admin();
      expect(view.counts.linesRead).toBe(lib.summary.linesRead);
      expect(view.counts.staleLines).toBe(lib.summary.stale);
    },
    TIMEOUT,
  );
});

describe('2. Booked lifecycle through the store', () => {
  it(
    'book Amanda for O34 -> gone from every opening; a second booking of O34 is refused; undo brings her back; history kept',
    async () => {
      await postOk(sampleFiles());
      const store = getStore();
      const v0 = await store.version();
      expect(v0).toBe(1);

      const before = await currentRun(store);
      const beforeCsv = resultsCsv(before.results);
      const beforeVerdicts = await verdictsText();
      const beforeAdmin = await admin();
      // The test bites: Amanda is offered in the sample, O34 among them.
      expect(amandaShown(before)).toBe(true);
      expect(before.results.find((r) => r.openingId === 'O34')!.suggestions.map((s) => s.lineId)).toContain(AMANDA.newest);

      const amanda = booking();
      expect(await store.addBooked(amanda)).toEqual({ ok: true });
      expect(await store.version()).toBe(v0 + 1);
      expect(await store.listBooked()).toEqual([amanda]);
      expect((await state()).version).toBe(v0 + 1);

      const booked = await currentRun(store);
      expect(amandaShown(booked), resultsCsv(booked.results)).toBe(false);
      for (const r of booked.results) {
        expect(passingIds(r), r.openingId).not.toContain(AMANDA.newest);
        // Everyone else keeps the waitlist order and the first 3 that pass.
        expect(r.suggestions.map((s) => s.lineId), r.openingId).toEqual(passingIds(r).slice(0, MAX_SUGGESTIONS));
      }
      const person = booked.people.find((p) => p.key === AMANDA.newest)!;
      expect(person.tags.map((t) => t.kind)).toContain('booked');
      // B5 lists her under "Not offered, and why" as booked through the tool, never in the people table.
      const view = await admin();
      expect(view.people.map((p) => p.line)).not.toContain(AMANDA.newest);
      const row = view.notOffered.find((r) => r.lineIds.includes(AMANDA.newest))!;
      expect(row.kind).toBe('booked');
      expect(row.why).toContain('Booked through the tool for O34 on Oct 21.');
      expect(view.counts.peopleReady).toBe(beforeAdmin.counts.peopleReady - 1);
      // The line-verdicts route reads the same records.
      expect(await verdictsText()).not.toBe(beforeVerdicts);

      // A second Booked on O34, for anyone, is refused with the record already there; nothing changes.
      const other = before.people.find((p) => p.key === 'W33')!;
      const second = await store.addBooked(
        booking({ personName: other.name, personPhoneDigits: other.phoneDigits, lineId: other.newestId, at: '2026-10-21T15:00:00.000Z' }),
      );
      expect(second).toEqual({ ok: false, existing: amanda });
      expect(await store.addBooked(booking())).toEqual({ ok: false, existing: amanda }); // a double tap, same person
      expect(await store.version()).toBe(v0 + 1);
      expect(await store.listBooked()).toEqual([amanda]);

      // Undo: she is back exactly as before, everywhere.
      expect(await store.removeBooked('O34')).toBe(true);
      expect(await store.version()).toBe(v0 + 2);
      expect(await store.listBooked()).toEqual([]);
      const after = await currentRun(store);
      expect(resultsCsv(after.results)).toBe(beforeCsv);
      expect(await verdictsText()).toBe(beforeVerdicts);
      expect(await admin()).toEqual(beforeAdmin);
      // Undo of an opening with no booking does nothing.
      expect(await store.removeBooked('O34')).toBe(false);
      expect(await store.version()).toBe(v0 + 2);

      // Nothing is deleted: the undone record is kept in the history file.
      const history = JSON.parse(fs.readFileSync(path.join(dir, 'booked-history.json'), 'utf8')) as { record: BookedRecord; undoneAt: string }[];
      expect(history).toHaveLength(1);
      expect(history[0]!.record).toEqual(amanda);
      expect(Number.isNaN(Date.parse(history[0]!.undoneAt))).toBe(false);
      // The import is still there too.
      expect((await store.latestImport())!.id).toBe((await state()).import.id);
    },
    TIMEOUT,
  );
});

describe('3. Booked survives a new import (build-plan section 4)', () => {
  it(
    'a new waitlist with an unrelated line keeps Amanda skipped; a newer line from Amanda (after the booking) frees her',
    async () => {
      await postOk(sampleFiles());
      const store = getStore();
      // Tanya booked Amanda on Oct 19 (before the newer line below).
      const amanda = booking({ at: '2026-10-19T15:00:00.000Z' });
      expect(await store.addBooked(amanda)).toEqual({ ok: true });
      expect(amandaShown(await currentRun(store))).toBe(false);

      // New waitlist: one extra, unrelated line (a new person; not read, since there is no Claude).
      const unrelated = `61,10/20,${NEW_PERSON.name},${NEW_PERSON.phone},${NEW_PERSON.notes}`;
      const second = { ...sampleFiles(), waitlist: { name: 'waitlist-2026-10-21b.csv', text: withRows(sampleText(NAMES.waitlist), [unrelated]) } };
      const body2 = await postOk(second);
      expect(body2.view.counts.linesRead).toBe(61);
      expect(await store.listBooked()).toEqual([amanda]); // the booked records are kept
      const run2 = await currentRun(store);
      expect((await store.latestImport())!.files.waitlist.name).toBe('waitlist-2026-10-21b.csv');
      expect(amandaShown(run2), resultsCsv(run2.results)).toBe(false);
      for (const r of run2.results) expect(passingIds(r), r.openingId).not.toContain(AMANDA.newest);
      expect(run2.people.find((p) => p.key === AMANDA.newest)!.tags.map((t) => t.kind)).toContain('booked');
      const view2 = await admin();
      expect(view2.people.map((p) => p.name)).not.toContain(AMANDA.name);
      expect(view2.notOffered.find((r) => r.lineIds.includes(AMANDA.newest))!.kind).toBe('booked');
      // The import response itself (B5 right after "Import and analyse") agrees.
      expect(body2.view.people.map((p: { name: string }) => p.name)).not.toContain(AMANDA.name);

      // Amanda calls again: a newer line dated Oct 20, after the booking (Oct 19). Claude (mocked) reads her new
      // group through the import service (the route builds no client under SHORTLIST_NO_CLAUDE).
      const newer = '62,10/20,Amanda B.,506-555-0125,still wants in - same as before';
      const thirdFiles = { ...second, waitlist: { name: 'waitlist-2026-10-21c.csv', text: withRows(second.waitlist.text, [newer]) } };
      const odile = defaultReading();
      odile.lengths = { value: { minutes: [60], only: false }, source: [{ lineId: 'W61', text: '60' }] };
      odile.daysExcluded = { value: ['Mon'], source: [{ lineId: 'W61', text: 'not Mon' }] };
      const { client, calls } = mockClient({ 'W26,W42,W62': savedReading(AMANDA.newest), W61: odile });
      const input: ImportInput = { ...thirdFiles, runDate: SAMPLE_RUN_DATE };
      const res3 = await importFiles(input, { store, client });
      expect(res3.ok, res3.ok ? '' : res3.message).toBe(true);
      expect([...calls].sort()).toEqual(['W26,W42,W62', 'W61']);
      expect(await store.listBooked()).toEqual([amanda]); // the record is kept; it just no longer applies

      const run3 = await currentRun(store);
      const person = run3.people.find((p) => p.lineIds.includes('W62'))!;
      expect(person.lineIds).toEqual(['W26', 'W42', 'W62']);
      expect(person.newestId).toBe('W62');
      expect(person.tags).toEqual([]);
      // She passes again wherever her notes fit, under her newest line id, and is shown wherever fewer than 3
      // people higher on the list also pass.
      const passing = run3.results.filter((r) => passingIds(r).includes('W62'));
      expect(passing.length).toBeGreaterThan(0);
      expect(passing.map((r) => r.openingId)).toContain('O34');
      for (const r of run3.results) {
        const ids = r.suggestions.map((s) => s.lineId);
        expect(ids, r.openingId).not.toContain('W42'); // never under an older line id
        expect(ids, r.openingId).toEqual(passingIds(r).slice(0, MAX_SUGGESTIONS));
        if (passingIds(r).includes('W62') && passingIds(r).filter((id) => lineNo(id) < 62).length < MAX_SUGGESTIONS) {
          expect(ids, r.openingId).toContain('W62');
        }
      }
      // B5 shows her in the people table under W62, merged with W26 and W42.
      const view3 = await admin();
      const row = view3.people.find((p) => p.line === 'W62')!;
      expect(row).toMatchObject({ name: AMANDA.name, merged: 'merged W26, W42' });
      expect(view3.notOffered.find((r) => r.lineIds.includes('W62'))).toBeUndefined();

      // The same files again through POST /api/import (no Claude): the cached reading is used, same answer.
      const body4 = await postOk(thirdFiles);
      expect(body4.view.counts.notRead).toBe(0);
      expect(resultsCsv((await currentRun(store)).results)).toBe(resultsCsv(run3.results));
    },
    TIMEOUT,
  );
});

describe('4. every import is kept', () => {
  it(
    'three imports: latestImport is the third; the first two are still on disk, unchanged',
    async () => {
      const store = getStore();
      const ids: string[] = [];
      const files = [
        sampleFiles(),
        { ...sampleFiles(), waitlist: { name: 'w2.csv', text: withRows(sampleText(NAMES.waitlist), [`61,10/20,${NEW_PERSON.name},${NEW_PERSON.phone},${NEW_PERSON.notes}`]) } },
        { ...sampleFiles(), waitlist: { name: 'w3.csv', text: sampleText(NAMES.waitlist) } },
      ];
      const onDisk: string[] = [];
      for (const f of files) {
        const body = await postOk(f);
        ids.push(body.import.id);
        const file = path.join(dir, 'imports', `${body.import.id}.json`);
        expect(fs.existsSync(file)).toBe(true);
        onDisk.push(fs.readFileSync(file, 'utf8'));
      }
      expect(new Set(ids).size).toBe(3);
      expect((await store.latestImport())!.id).toBe(ids[2]);
      expect((await state()).import.id).toBe(ids[2]);
      expect((await state()).version).toBe(3);
      expect((await admin()).import.files.waitlist.name).toBe('w3.csv');
      expect(await (store as LocalStore).listImportIds()).toEqual(ids);
      // Nothing was deleted or rewritten.
      ids.forEach((id, i) => {
        const file = path.join(dir, 'imports', `${id}.json`);
        expect(fs.readFileSync(file, 'utf8'), id).toBe(onDisk[i]);
        expect(JSON.parse(onDisk[i]!).files.waitlist.name).toBe(files[i]!.waitlist.name);
      });
      expect(fs.readdirSync(path.join(dir, 'imports')).sort()).toEqual(ids.map((id) => `${id}.json`).sort());
    },
    TIMEOUT,
  );
});

describe('5. restart safety', () => {
  it(
    'after an import and a booking, a fresh LocalStore on the same folder sees the same import, bookings and version',
    async () => {
      await postOk(sampleFiles());
      const store = getStore();
      await store.addBooked(booking());
      const runBefore = await currentRun(store);

      const fresh = new LocalStore(dir);
      expect(fresh).not.toBe(store);
      expect(await fresh.latestImport()).toEqual(await store.latestImport());
      expect(await fresh.listBooked()).toEqual([booking()]);
      expect(await fresh.version()).toBe(await store.version());
      expect(await fresh.version()).toBe(2);
      // And the same run: Amanda still skipped after the "restart".
      const runAfter = await currentRun(fresh);
      expect(resultsCsv(runAfter.results)).toBe(resultsCsv(runBefore.results));
      expect(amandaShown(runAfter)).toBe(false);
      // A refused booking from the fresh store sees the saved record.
      expect(await fresh.addBooked(booking({ personName: 'Someone Else', personPhoneDigits: '5065550000' }))).toEqual({
        ok: false,
        existing: booking(),
      });
    },
    TIMEOUT,
  );
});

describe('6. one booking per opening under concurrency', () => {
  it(
    'five simultaneous bookings of O34 for five people: exactly one saved, four refused with it, version +1',
    async () => {
      await postOk(sampleFiles());
      const store = getStore();
      const run = await currentRun(store);
      const people = ['W33', 'W42', 'W48', 'W49', 'W51'].map((id) => run.people.find((p) => p.key === id)!);
      const records = people.map((p, i) =>
        booking({ personName: p.name, personPhoneDigits: p.phoneDigits, lineId: p.newestId, at: `2026-10-21T15:00:0${i}.000Z` }),
      );
      const v0 = await store.version();

      const results = await Promise.all(records.map((r) => store.addBooked(r)));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const saved = await store.listBooked();
      expect(saved).toHaveLength(1);
      expect(records).toContainEqual(saved[0]);
      const refused = results.filter((r): r is { ok: false; existing: BookedRecord } => !r.ok);
      expect(refused).toHaveLength(4);
      for (const r of refused) expect(r.existing).toEqual(saved[0]);
      expect(await store.version()).toBe(v0 + 1);

      // Two store objects on the same folder (two routes, one process) racing for another opening.
      const a = new LocalStore(dir);
      const b = new LocalStore(dir);
      const race = await Promise.all([
        a.addBooked(booking({ openingId: 'O35', ...pick(people[0]!) })),
        b.addBooked(booking({ openingId: 'O35', ...pick(people[2]!) })),
        a.addBooked(booking({ openingId: 'O35', ...pick(people[3]!) })),
      ]);
      expect(race.filter((r) => r.ok)).toHaveLength(1);
      expect((await store.listBooked()).filter((r) => r.openingId === 'O35')).toHaveLength(1);
      expect(await store.version()).toBe(v0 + 2);
    },
    TIMEOUT,
  );
});

function pick(p: { name: string; phoneDigits: string; newestId: string }) {
  return { personName: p.name, personPhoneDigits: p.phoneDigits, lineId: p.newestId };
}

describe('7. Friday-style import without Claude', () => {
  it(
    'B5 counts the not-read people and warns; they are only in "Not offered, and why"; /api/state has the new import',
    async () => {
      const files = rehearsalFiles();
      const body = await postOk(files, FRIDAY_RUN_DATE);
      expect(body.view.counts.notRead).toBe(3);

      const view = await admin();
      expect(view.counts.linesRead).toBe(63);
      expect(view.counts.notRead).toBe(3);
      expect(view.claudeConnected).toBe(false);
      expect(view.notReadWarning).toBe("3 people's notes weren't read because Claude isn't connected; they won't be suggested.");
      expect(view.files.map((f) => f.check)).toEqual(['63 lines · columns OK', '10 openings · columns OK', '597 appointments · columns OK']);

      const notRead = view.notOffered.filter((r) => r.kind === 'not read');
      expect(notRead.map((r) => r.lineIds.at(-1)).sort()).toEqual([...CHANGED_NEWEST].sort());
      for (const r of notRead) expect(r.why).toBe('Notes not read yet, so not offered.');
      expect(notRead.map((r) => r.who).sort()).toEqual(
        [`${NEW_PERSON.id} ${NEW_PERSON.name}`, `${REPEAT.of}, ${REPEAT.id} ${REPEAT.name}`, `${MOVED.of}, ${MOVED.id} ${MOVED.name}`].sort(),
      );
      // The booked-since person from the newer booking export is stale, with the reason.
      expect(view.notOffered.find((r) => r.lineIds.includes(BOOKED_SINCE.id))).toMatchObject({ kind: 'stale', why: BOOKED_SINCE.reason });

      const changedLines = [NEW_PERSON.id, REPEAT.id, REPEAT.of, MOVED.id, MOVED.of, BOOKED_SINCE.id];
      for (const id of changedLines) expect(view.people.map((p) => p.line), id).not.toContain(id);
      const run = await currentRun();
      expect([...run.summary.notRead].sort()).toEqual([...CHANGED_NEWEST].sort());
      expect(run.results.map((r) => r.openingId)).toEqual(OPENINGS.map((o) => o[0]));
      for (const id of changedLines) expect(shownIds(run), id).not.toContain(id);
      for (const name of [NEW_PERSON.name, REPEAT.name, MOVED.name, BOOKED_SINCE.name]) expect(shownNames(run), name).not.toContain(name);
      expect(shownIds(run).length).toBeGreaterThan(0); // not trivially empty

      const s = await state();
      expect(s.version).toBe(1);
      expect(s.import).toMatchObject({ id: body.import.id, runDate: FRIDAY_RUN_DATE, bookingExportDate: '2026-10-23' });
      expect(s.import.files.waitlist.name).toBe(files.waitlist.name);
      expect(s.import.files.appointments.name).toBe(files.appointments.name);
      expect(s.import.files.openings.name).toBe(files.openings.name);
    },
    TIMEOUT,
  );
});

describe('8. privacy across the server', () => {
  async function expectClean(files: Files, runDate: string) {
    const notes = parseWaitlist(files.waitlist.text, RUN_YEAR)
      .map((l) => l.notes.trim())
      .filter((t) => t !== '');
    expect(notes.length).toBeGreaterThan(50);
    // The scan bites: the waitlist itself has health words.
    expect(healthHits(files.waitlist.text).length).toBeGreaterThan(3);

    const importBody = await postOk(files, runDate);
    const outputs: Record<string, { text: string; strings: string[] }> = {};
    const adminBody = await admin();
    const stateBody = await state();
    const csv = await verdictsText();
    outputs['POST /api/import'] = { text: JSON.stringify(importBody), strings: stringsIn(importBody) };
    outputs['GET /api/admin'] = { text: JSON.stringify(adminBody), strings: stringsIn(adminBody) };
    outputs['GET /api/state'] = { text: JSON.stringify(stateBody), strings: stringsIn(stateBody) };
    outputs['GET /api/line-verdicts.csv'] = { text: csv, strings: csv.split('\n') };

    for (const [label, out] of Object.entries(outputs)) {
      expect(healthHits(out.text), `${label}: health words`).toEqual([]);
      // No full note text: no string the server sends contains a whole note.
      for (const note of notes) {
        const leak = out.strings.find((s) => s.includes(note));
        expect(leak, `${label}: contains the note "${note}"`).toBeUndefined();
      }
      expect(out.text).not.toContain('"notes"');
      expect(out.text).not.toContain('"text"');
    }

    // Prenatal people: the therapist cell's source is only the clinic rule, never their words.
    const run = await currentRun();
    const prenatal = run.people.filter((p) => run.reads.get(p.key)?.reading?.prenatal.value === true).map((p) => p.newestId);
    const rows = adminBody.people.filter((p) => prenatal.includes(p.line));
    for (const row of rows) {
      expect(row.therapist.source, row.line).toBe(CLINIC_RULE_SOURCE);
      expect(['Amira or Kelsey', 'Amira', 'Kelsey', 'No therapist fits'], row.line).toContain(row.therapist.value);
    }
    // Nobody else gets the clinic-rule source.
    for (const row of adminBody.people.filter((p) => !prenatal.includes(p.line))) {
      expect(row.therapist.source, row.line).not.toBe(CLINIC_RULE_SOURCE);
    }
    return { prenatal, rows };
  }

  it(
    'sample import: /api/import, /api/admin, /api/state and line-verdicts.csv carry no health words and no notes',
    async () => {
      const { prenatal, rows } = await expectClean(sampleFiles(), SAMPLE_RUN_DATE);
      // The sample has at least one prenatal person shown in B5 (so the clinic-rule check bites).
      expect(prenatal.length).toBeGreaterThan(0);
      expect(rows.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'Friday-style import (not-read people, booked-since) and a booking: still no health words and no notes',
    async () => {
      await postOk(sampleFiles());
      await getStore().addBooked(booking({ at: '2026-10-25T15:00:00.000Z' }));
      await expectClean(rehearsalFiles(), FRIDAY_RUN_DATE);
    },
    TIMEOUT,
  );
});

describe('9. a bad import changes nothing', () => {
  it(
    'a waitlist missing the notes column: 400 naming it; latest import, bookings, version and disk unchanged',
    async () => {
      const first = await postOk(sampleFiles());
      const store = getStore();
      await store.addBooked(booking());
      const before = {
        latest: await store.latestImport(),
        booked: await store.listBooked(),
        version: await store.version(),
        state: await state(),
        admin: await admin(),
        imports: fs.readdirSync(path.join(dir, 'imports')).sort(),
      };
      expect(before.version).toBe(2);

      const bad = sampleText(NAMES.waitlist).replace(/^line,added,name,phone,notes/, 'line,added,name,phone,comments');
      expect(bad.split('\r\n')[0]).toBe('line,added,name,phone,comments');
      const { status, body } = await postImport({ ...sampleFiles(), waitlist: { name: 'no-notes-waitlist.csv', text: bad } });
      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.problems).toEqual([{ kind: 'waitlist', missing: ['notes'] }]);
      expect(body.message).toContain('notes');
      expect(body.message).toContain('no-notes-waitlist.csv');
      expect(body.files.find((f: { kind: string }) => f.kind === 'waitlist').check).toBe('Missing column(s): notes');
      expect(body.files.find((f: { kind: string }) => f.kind === 'openings').ok).toBe(true);

      expect(await store.latestImport()).toEqual(before.latest);
      expect((await store.latestImport())!.id).toBe(first.import.id);
      expect(await store.listBooked()).toEqual(before.booked);
      expect(await store.version()).toBe(before.version);
      expect(await state()).toEqual(before.state);
      expect(await admin()).toEqual(before.admin);
      expect(fs.readdirSync(path.join(dir, 'imports')).sort()).toEqual(before.imports);
      // A fresh store on the folder agrees (nothing half-written).
      const fresh = new LocalStore(dir);
      expect((await fresh.latestImport())!.id).toBe(first.import.id);
      expect(await fresh.version()).toBe(before.version);
    },
    TIMEOUT,
  );
});

describe('10. the booking day is the clinic\'s day (America/Moncton), not the UTC day', () => {
  // KNOWN BUG (src/lib/import.ts, bookedTags + isoDay): the booking's day is taken as `at.slice(0, 10)`, the UTC
  // date of the ISO timestamp. A Booked tap after 9 PM in New Brunswick (ADT, UTC-3) is already the next day in UTC,
  // so a newer line written the next morning is not seen as newer and the person stays skipped (rules.md Step 2:
  // "If they call again later and get a newer line, the tag no longer applies from that line"). B5 also shows
  // the wrong booking date. src/lib/format.ts todayIso already uses America/Moncton for the clinic's day.
  it(
    'booked Mon Oct 19 at 9:30 PM clinic time; a new line on Oct 20 frees her, and B5 says "on Oct 19"',
    async () => {
      await postOk(sampleFiles());
      const store = getStore();
      const at = '2026-10-20T00:30:00.000Z'; // = 2026-10-19 21:30 in America/Moncton
      expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Moncton' }).format(new Date(at))).toBe('2026-10-19');
      await store.addBooked(booking({ at }));

      const view = await admin();
      expect.soft(view.notOffered.find((r) => r.lineIds.includes(AMANDA.newest))!.why).toContain('Booked through the tool for O34 on Oct 19.');

      const newer = '61,10/20,Amanda B.,506-555-0125,still wants in - same as before';
      const { client } = mockClient({ 'W26,W42,W61': savedReading(AMANDA.newest) });
      const res = await importFiles(
        { ...sampleFiles(), waitlist: { name: 'w.csv', text: withRows(sampleText(NAMES.waitlist), [newer]) }, runDate: SAMPLE_RUN_DATE },
        { store, client },
      );
      expect(res.ok).toBe(true);
      const person = (await currentRun(store)).people.find((p) => p.newestId === 'W61')!;
      expect(person.tags).toEqual([]);
    },
    TIMEOUT,
  );
});
