// Integration: Features 1-6b through the Search screen's routes. POST /api/search (one opening), POST
// /api/search/file (all openings from a file), POST and DELETE /api/booked, together with the 6a routes
// (POST /api/import, GET /api/state, /api/admin, /api/line-verdicts.csv) and the CLI library (runShortlist +
// resultsCsv). Route handlers are called directly with Request objects; no dev server is used or started.
// Expected behaviour: ../build-plan.md section 4 "Keeping the backend in sync (Booked)" (save first then show;
// everything reads the same records; one booking per opening; undo; booked survives a new import), section 6
// Screens 1-2 and Admin, section 7 (done checks); ../rules.md "The aim", Steps 2 and 4, "Always".
// Every test gets its own empty SHORTLIST_DATA_DIR with SHORTLIST_NO_CLAUDE=1, and imports the sample through the
// import route. data/sample/ is only read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as importPOST } from '@/app/api/import/route';
import { GET as adminGET } from '@/app/api/admin/route';
import { GET as stateGET } from '@/app/api/state/route';
import { GET as verdictsGET } from '@/app/api/line-verdicts.csv/route';
import { POST as searchPOST } from '@/app/api/search/route';
import { POST as fileSearchPOST } from '@/app/api/search/file/route';
import { DELETE as bookedDELETE, POST as bookedPOST } from '@/app/api/booked/route';
import { openRunCache } from '@/lib/cache-setup';
import { parseCsv, parseOpenings, parseWaitlist } from '@/lib/csv';
import { shortDate } from '@/lib/normalise';
import { resultsCsv, runShortlist } from '@/lib/run';
import { parseAnswerKey, parseResultsCsv } from '@/lib/score';
import { telHref } from '@/lib/search-view';
import type { OpeningView } from '@/lib/search-view';
import type { AdminView } from '@/lib/server/views';
import { getStore } from '@/lib/storage';
import type { BookedRecord, Opening } from '@/lib/types';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLE = path.join(ROOT, 'data', 'sample');
const NAMES = {
  waitlist: 'waitlist-2026-10-21.csv',
  openings: 'late-openings-2026-09-21-to-2026-10-17.csv',
  appointments: 'appointments-2026-09-21-to-2026-10-17.csv',
} as const;
const sampleText = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');
const RUN_DATE = '2026-10-21';
const RUN_YEAR = 2026;
const TIMEOUT = 180_000;

type Kind = keyof typeof NAMES;
type Files = Record<Kind, { name: string; text: string }>;
const sampleFiles = (): Files => ({
  waitlist: { name: NAMES.waitlist, text: sampleText(NAMES.waitlist) },
  openings: { name: NAMES.openings, text: sampleText(NAMES.openings) },
  appointments: { name: NAMES.appointments, text: sampleText(NAMES.appointments) },
});
/** The sample waitlist plus rows typed the way the sample is (CRLF line ends). */
const withRows = (text: string, rows: string[]) => text + rows.map((r) => `${r}\r\n`).join('');

const SAMPLE_OPENINGS: Opening[] = parseOpenings(sampleText(NAMES.openings));
const LATE = SAMPLE_OPENINGS.filter((o) => o.kind === 'late cancel');
const openingOf = (id: string) => SAMPLE_OPENINGS.find((o) => o.opening_id === id)!;
/** Tanya's answer key: opening id -> every line id that fits, in list order. */
const KEY = parseAnswerKey(sampleText('answer-key-tanya.csv')).openings;

const AMANDA = { name: 'Amanda Bourgeois', lines: ['W26', 'W42'], newest: 'W42' };

// ---- nothing outside the temp dirs is touched ------------------------------------------------------------

const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(path.join(SAMPLE, f)));

let TMP = '';
let n = 0;
let cliCsv = '';
const env = { data: process.env.SHORTLIST_DATA_DIR, noClaude: process.env.SHORTLIST_NO_CLAUDE };

beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-search-book-'));
  process.env.SHORTLIST_NO_CLAUDE = '1';
  // The CLI library on the same files, with its own cache and no Booked marks.
  const lib = await runShortlist({
    waitlistText: sampleText(NAMES.waitlist),
    openingsText: sampleText(NAMES.openings),
    appointmentsText: sampleText(NAMES.appointments),
    runDate: RUN_DATE,
    cache: openRunCache(path.join(TMP, 'cli-cache.json')),
    client: null,
  });
  cliCsv = resultsCsv(lib.results);
}, TIMEOUT);

// A fresh, empty store for every test (build-plan section 4: test runs use their own empty store).
beforeEach(() => {
  process.env.SHORTLIST_DATA_DIR = path.join(TMP, `store-${++n}`);
  process.env.SHORTLIST_NO_CLAUDE = '1';
});

afterAll(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('SHORTLIST_DATA_DIR', env.data);
  restore('SHORTLIST_NO_CLAUDE', env.noClaude);
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(path.join(SAMPLE, f)).equals(bytes), f).toBe(true);
  expect(fs.readdirSync(SAMPLE).sort()).toEqual([...sampleBytes.keys()].sort());
});

// ---- calling the routes (every JSON body is kept for the privacy scan) ------------------------------------

type Label = 'search' | 'search/file' | 'booked' | 'admin';
const seen: { label: Label; text: string; body: any }[] = [];

async function keep(label: Label, res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  const body = JSON.parse(text);
  seen.push({ label, text, body });
  return { status: res.status, body };
}

async function importFiles(files: Files = sampleFiles(), runDate = RUN_DATE): Promise<any> {
  const form = new FormData();
  for (const kind of ['waitlist', 'openings', 'appointments'] as const) {
    form.append(kind, new File([files[kind].text], files[kind].name, { type: 'text/csv' }));
  }
  form.append('runDate', runDate);
  const res = await importPOST(new Request('http://localhost/api/import', { method: 'POST', body: form }));
  const body = await res.json();
  expect(res.status, body.message).toBe(200);
  return body;
}

interface OneInput {
  date: string;
  start: string;
  therapist: string;
  length: number;
  cancelledAt: string;
}
const inputOf = (o: Opening): OneInput => ({
  date: o.date,
  start: o.start,
  therapist: o.therapist,
  length: o.length_min,
  cancelledAt: o.cancelled_at,
});

async function searchOne(input: OneInput): Promise<OpeningView> {
  const res = await searchPOST(
    new Request('http://localhost/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
  const { status, body } = await keep('search', res);
  expect(status, body.message).toBe(200);
  return body.opening;
}

async function searchFile(): Promise<any> {
  const res = await fileSearchPOST(new Request('http://localhost/api/search/file', { method: 'POST', body: new FormData() }));
  const { status, body } = await keep('search/file', res);
  expect(status, body.message).toBe(200);
  return body;
}

async function book(openingId: string, lineId: string): Promise<{ status: number; body: any }> {
  const res = await bookedPOST(
    new Request('http://localhost/api/booked', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ openingId, lineId }),
    }),
  );
  return keep('booked', res);
}

async function undo(openingId: string): Promise<{ status: number; body: any }> {
  const res = await bookedDELETE(
    new Request(`http://localhost/api/booked?openingId=${encodeURIComponent(openingId)}`, { method: 'DELETE' }),
  );
  return keep('booked', res);
}

async function admin(): Promise<AdminView> {
  return (await keep('admin', await adminGET())).body;
}
const version = async (): Promise<number> => ((await (await stateGET()).json()) as { version: number }).version;
async function verdicts(): Promise<Map<string, { verdict: string; reason: string }>> {
  const res = await verdictsGET();
  expect(res.status).toBe(200);
  return new Map(parseCsv(await res.text()).map((r) => [r.line!, { verdict: r.verdict!, reason: r.reason! }]));
}

const ids = (o: OpeningView) => o.cards.map((c) => c.lineId);
const byId = (views: OpeningView[]) => new Map(views.map((v) => [v.id, v]));
const lineNo = (id: string) => Number(id.slice(1));
/** The clinic's day of a Booked timestamp (America/Moncton), as the B5 reason uses it. */
const clinicDay = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Moncton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const bookedReason = (r: BookedRecord) => `Booked through the tool for ${r.openingId} on ${shortDate(clinicDay(r.at))}.`;
/** Amanda (either line id, or her name) on any card of any opening. */
const amandaShown = (views: OpeningView[]) =>
  views.some((v) => v.cards.some((c) => AMANDA.lines.includes(c.lineId) || c.name === AMANDA.name));

// =============================================================================================================

describe('1. one opening = file = CLI', () => {
  it(
    'every late-cancel opening: POST /api/search gives the same line ids as the file search and resultsCsv, under the file\'s opening id',
    async () => {
      await importFiles();
      const file = await searchFile();
      expect(file.resultsCsv).toBe(cliCsv);
      const cli = parseResultsCsv(cliCsv);
      const fileViews = byId(file.openings);
      expect(LATE.length).toBe(36);

      let withNames = 0;
      for (const o of LATE) {
        const one = await searchOne(inputOf(o));
        // The file's id, not a Q- id: the slot is one opening whichever mode found it.
        expect(one.id, o.opening_id).toBe(o.opening_id);
        expect(one.kind).toBe('late cancel');
        expect(ids(one), o.opening_id).toEqual(ids(fileViews.get(o.opening_id)!));
        expect(ids(one), o.opening_id).toEqual(cli.get(o.opening_id));
        expect(one.cards, o.opening_id).toEqual(fileViews.get(o.opening_id)!.cards);
        expect(one.summary).toBe(fileViews.get(o.opening_id)!.summary);
        if (one.cards.length > 0) withNames++;
      }
      // The comparison bites: most late openings have names.
      expect(withNames).toBeGreaterThan(25);

      // The datetime-local form of cancelledAt finds the same slot and the same names.
      const o39 = openingOf('O39');
      const local = await searchOne({ ...inputOf(o39), cancelledAt: o39.cancelled_at.replace(' ', 'T') });
      expect(local.id).toBe('O39');
      expect(ids(local)).toEqual(cli.get('O39'));
    },
    TIMEOUT,
  );
});

describe('2. Booked from the search reaches every view', () => {
  it(
    'Amanda (W42) on O34: state version, B5 "Not offered", one fewer ready, line verdicts, file search and one-opening search agree',
    async () => {
      await importFiles();
      const v0 = await version();
      const admin0 = await admin();
      const verdicts0 = await verdicts();
      const file0 = await searchFile();
      const o35Before = await searchOne(inputOf(openingOf('O35')));
      // The test bites: before the booking she is offered in O34 and O35, ready in B5 and active in the verdicts.
      expect(ids(byId(file0.openings).get('O34')!)).toContain(AMANDA.newest);
      expect(ids(o35Before)).toContain(AMANDA.newest);
      expect(admin0.people.map((p) => p.line)).toContain(AMANDA.newest);
      expect(verdicts0.get('W42')!.verdict).toBe('active');
      expect(verdicts0.get('W26')!.verdict).toBe('duplicate of W42');

      const { status, body } = await book('O34', AMANDA.newest);
      expect(status, body.message).toBe(200);
      const record: BookedRecord = body.record;
      expect(record).toMatchObject({ openingId: 'O34', lineId: 'W42', personName: AMANDA.name, by: 'local' });

      // GET /api/state: one change.
      expect(await version()).toBe(v0 + 1);
      expect(body.version).toBe(v0 + 1);

      // GET /api/admin: booked in "Not offered, and why", not in the people table, one fewer ready.
      const view = await admin();
      const row = view.notOffered.find((r) => r.lineIds.includes(AMANDA.newest))!;
      expect(row).toBeDefined();
      expect(row.kind).toBe('booked');
      expect(row.lineIds).toEqual(AMANDA.lines);
      expect(row.why).toContain(bookedReason(record));
      expect(view.people.map((p) => p.line)).not.toContain(AMANDA.newest);
      expect(view.counts.peopleReady).toBe(admin0.counts.peopleReady - 1);

      // GET /api/line-verdicts.csv: both her lines stale with the booked reason; nothing else changed.
      const v1 = await verdicts();
      for (const id of AMANDA.lines) {
        expect(v1.get(id)!.verdict, id).toBe('stale');
        expect(v1.get(id)!.reason, id).toContain(bookedReason(record));
      }
      for (const [id, v] of verdicts0) if (!AMANDA.lines.includes(id)) expect(v1.get(id), id).toEqual(v);

      // File search: O34 filled by her; she is on no other card.
      const file1 = await searchFile();
      const o34 = byId(file1.openings).get('O34')!;
      expect(o34.fitLabel).toBe('Filled');
      expect(o34.cards).toEqual([]);
      expect(o34.filled).toMatchObject({ lineId: 'W42', name: AMANDA.name, at: record.at });
      expect(amandaShown(file1.openings)).toBe(false);
      expect(file1.counts.filled).toBe(1);
      expect(file1.resultsCsv).not.toContain(AMANDA.name);

      // One-opening search for O35's slot: not her; the rest still in waitlist order and on Tanya's list.
      const o35 = await searchOne(inputOf(openingOf('O35')));
      expect(o35.filled).toBeNull();
      expect(amandaShown([o35])).toBe(false);
      // Everyone shown before (except her) is still shown, first, in the same order.
      const kept = ids(o35Before).filter((id) => id !== AMANDA.newest);
      expect(ids(o35).slice(0, kept.length)).toEqual(kept);
      for (const id of ids(o35)) expect(KEY.get('O35')).toContain(id);
      expect(ids(o35)).toEqual(ids(byId(file1.openings).get('O35')!));
    },
    TIMEOUT,
  );
});

describe('3. precision holds while booking down the list', () => {
  const TARGETS = ['O34', 'O35', 'O36', 'O38', 'O39'];

  /** The Friday rule against the key for every unfilled opening; one person per filled opening; no booked person shown. */
  function expectPrecise(views: OpeningView[], booked: Map<string, string>, step: string) {
    const filled = views.filter((v) => v.filled !== null);
    expect(new Map(filled.map((v) => [v.id, v.filled!.lineId])), step).toEqual(booked);
    const filledLines = filled.map((v) => v.filled!.lineId);
    expect(new Set(filledLines).size, `${step}: someone fills two openings`).toBe(filledLines.length);
    for (const v of views) {
      if (v.filled) continue;
      const key = KEY.get(v.id) ?? [];
      for (const id of ids(v)) {
        expect(key, `${step}: ${v.id} shows ${id}, not on Tanya's list`).toContain(id);
        expect(filledLines, `${step}: ${v.id} shows ${id}, already booked`).not.toContain(id);
      }
      // Waitlist order: line numbers go up from card 1 to card 3.
      const nums = ids(v).map(lineNo);
      expect(nums, `${step}: ${v.id} order`).toEqual([...nums].sort((a, b) => a - b));
      expect(v.cards.length).toBeLessThanOrEqual(3);
    }
  }

  it(
    'a morning: book the first suggested person for 5 openings one after another; Friday rule after every step; undo all five',
    async () => {
      await importFiles();
      const v0 = await version();
      const original = await searchFile();
      expect(original.resultsCsv).toBe(cliCsv);
      expectPrecise(original.openings, new Map(), 'start');

      const booked = new Map<string, string>();
      for (const target of TARGETS) {
        // Re-search the opening Tanya is working on (one-opening mode), and call the first card.
        const one = await searchOne(inputOf(openingOf(target)));
        expect(one.id).toBe(target);
        expect(one.filled, target).toBeNull();
        expect(one.cards.length, `${target} has someone to call`).toBeGreaterThan(0);
        const first = one.cards[0]!;
        expect(KEY.get(target), target).toContain(first.lineId);
        expect([...booked.values()], target).not.toContain(first.lineId);

        const { status, body } = await book(target, first.lineId);
        expect(status, `${target}: ${body.message}`).toBe(200);
        booked.set(target, first.lineId);

        const file = await searchFile();
        expectPrecise(file.openings, booked, `after ${target}`);
        expect(file.counts.filled).toBe(booked.size);
        // The two modes still agree on every unfilled late opening after this booking.
        const views = byId(file.openings);
        for (const next of TARGETS.filter((t) => !booked.has(t))) {
          expect(ids(await searchOne(inputOf(openingOf(next)))), `${next} after ${target}`).toEqual(ids(views.get(next)!));
        }
      }
      expect(new Set(booked.values()).size).toBe(TARGETS.length);
      expect(await version()).toBe(v0 + TARGETS.length);

      // Undo all five: everything is back to the original.
      for (const target of [...TARGETS].reverse()) {
        const { status } = await undo(target);
        expect(status, target).toBe(200);
      }
      const back = await searchFile();
      expect(back.openings).toEqual(original.openings);
      expect(back.counts).toEqual(original.counts);
      expect(back.resultsCsv).toBe(cliCsv);
      expect(await version()).toBe(v0 + 2 * TARGETS.length);
    },
    TIMEOUT,
  );
});

describe('4. the same slot from both modes', () => {
  it(
    'booked from a one-opening search of O39\'s slot -> the file search shows O39 filled; a second booking from file mode is 409',
    async () => {
      await importFiles();
      const one = await searchOne({ date: '2026-10-15', start: '14:00', therapist: 'Dave Melanson', length: 60, cancelledAt: '2026-10-15T10:40' });
      expect(one.id).toBe('O39');
      const first = one.cards[0]!;
      expect(first.lineId).toBe('W46');
      const { status, body } = await book(one.id, first.lineId);
      expect(status, body.message).toBe(200);
      const record: BookedRecord = body.record;
      const v1 = await version();

      const file = await searchFile();
      const o39 = byId(file.openings).get('O39')!;
      expect(o39.fitLabel).toBe('Filled');
      expect(o39.filled).toMatchObject({ lineId: 'W46', name: 'Shawn Duguay' });
      expect(file.openings.some((v: OpeningView) => ids(v).includes('W46'))).toBe(false);

      // Someone else, still offered in file mode (on another opening's card), for the same opening.
      const other = (file.openings as OpeningView[]).flatMap((v) => v.cards).find((c) => c.lineId !== 'W46')!;
      expect(other).toBeDefined();
      const second = await book('O39', other.lineId);
      expect(second.status).toBe(409);
      expect(second.body.ok).toBe(false);
      expect(second.body.existing).toEqual(record);
      expect(second.body.message).toBe('Already filled by Shawn Duguay (line W46).');
      expect(await version()).toBe(v1);

      // And the one-opening search of the slot shows it filled too.
      const again = await searchOne(inputOf(openingOf('O39')));
      expect(again.filled).toMatchObject({ lineId: 'W46' });
      expect(again.cards).toEqual([]);
    },
    TIMEOUT,
  );
});

describe('5. race through the route', () => {
  it(
    '4 simultaneous POST /api/booked for O36 (its 3 suggested people + 1 repeat): exactly one 200, three 409, version +1',
    async () => {
      await importFiles();
      const o36 = byId((await searchFile()).openings).get('O36')!;
      expect(o36.cards).toHaveLength(3);
      const lines = [...ids(o36), ids(o36)[0]!];
      const v0 = await version();

      const results = await Promise.all(lines.map((line) => book('O36', line)));
      const ok = results.filter((r) => r.status === 200);
      const refused = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(refused).toHaveLength(3);
      const winner: BookedRecord = ok[0]!.body.record;
      expect(lines).toContain(winner.lineId);
      for (const r of refused) {
        expect(r.body.existing).toEqual(winner);
        expect(r.body.message).toBe(`Already filled by ${winner.personName} (line ${winner.lineId}).`);
      }
      expect(await version()).toBe(v0 + 1);
      expect(await getStore().listBooked()).toEqual([winner]);
      const file = await searchFile();
      expect(file.counts.filled).toBe(1);
      expect(byId(file.openings).get('O36')!.filled).toMatchObject({ lineId: winner.lineId });
    },
    TIMEOUT,
  );

  // rules.md Step 2: a booked person is "skipped for every other opening too"; build-plan section 4: every screen
  // reads the same records. Two staff tapping Booked for the same person on two different openings at once.
  // Was a real bug (both racing requests saved, so Amanda filled O34 and O35); fixed in LocalStore.addBooked,
  // which now also refuses a second live booking for the same person (same line id + phone) inside the locked write.
  it(
    'the same person booked for two different openings at the same time: only one booking is saved',
    async () => {
      await importFiles();
      const views = byId((await searchFile()).openings);
      expect(ids(views.get('O34')!)).toContain(AMANDA.newest);
      expect(ids(views.get('O35')!)).toContain(AMANDA.newest);
      const v0 = await version();

      const results = await Promise.all([book('O34', AMANDA.newest), book('O35', AMANDA.newest)]);
      const saved = await getStore().listBooked();
      expect(
        saved.map((r) => r.openingId),
        'Amanda was saved as filling two openings at once',
      ).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await version()).toBe(v0 + 1);
    },
    TIMEOUT,
  );
});

describe('6. people who are not offerable cannot be booked', () => {
  it(
    'a stale line (W23), an unknown line (W99) and a not-read new person (W61): 404, nothing saved, version unchanged',
    async () => {
      // A waitlist with one appended line: a new person whose notes are not read (no Claude).
      const files = sampleFiles();
      files.waitlist = {
        name: 'waitlist-2026-10-21b.csv',
        text: withRows(files.waitlist.text, ['61,10/20,Odile Comeau,506-555-0199,any - 60 - not Mon']),
      };
      const imported = await importFiles(files);
      expect(imported.view.counts.notRead).toBe(1);

      const view = await admin();
      expect(view.notOffered.find((r) => r.lineIds.includes('W61'))).toMatchObject({ kind: 'not read' });
      const v = await verdicts();
      expect(v.get('W23')!.verdict).toBe('stale');
      expect(v.has('W99')).toBe(false);
      const file0 = await searchFile();
      for (const id of ['W23', 'W61']) {
        expect(file0.openings.some((o: OpeningView) => ids(o).includes(id)), id).toBe(false);
      }

      const v0 = await version();
      for (const line of ['W23', 'W99', 'W61']) {
        const { status, body } = await book('O34', line);
        expect(status, line).toBe(404);
        expect(body.ok).toBe(false);
        expect(body.message).toContain(`Line ${line} is not someone the search can suggest right now.`);
        expect(await version(), line).toBe(v0);
        expect(await getStore().listBooked(), line).toEqual([]);
      }
      const file1 = await searchFile();
      expect(file1.counts.filled).toBe(0);
      expect(file1.openings).toEqual(file0.openings);
    },
    TIMEOUT,
  );
});

describe('7. Booked survives a re-import through the route and is undone cleanly', () => {
  it(
    'book W42 on O34, re-import the same files -> O34 still filled and W42 still skipped; undo -> W42 back in O34 in waitlist order',
    async () => {
      const first = await importFiles();
      const original = await searchFile();
      const o34Before = byId(original.openings).get('O34')!;
      expect(ids(o34Before)).toContain(AMANDA.newest);

      const { status, body } = await book('O34', AMANDA.newest);
      expect(status, body.message).toBe(200);
      const record: BookedRecord = body.record;

      const second = await importFiles();
      expect(second.import.id).not.toBe(first.import.id);
      // The import's own B5 answer already has her as booked.
      expect(second.view.people.map((p: { line: string }) => p.line)).not.toContain(AMANDA.newest);
      expect(second.view.notOffered.find((r: { lineIds: string[] }) => r.lineIds.includes(AMANDA.newest)).kind).toBe('booked');
      expect(await getStore().listBooked()).toEqual([record]);

      const after = await searchFile();
      const o34 = byId(after.openings).get('O34')!;
      expect(o34.filled).toMatchObject({ lineId: AMANDA.newest, name: AMANDA.name, at: record.at });
      expect(amandaShown(after.openings)).toBe(false);
      expect(amandaShown([await searchOne(inputOf(openingOf('O35')))])).toBe(false);
      expect((await admin()).notOffered.find((r) => r.lineIds.includes(AMANDA.newest))!.why).toContain(bookedReason(record));
      // A second booking of O34 after the re-import is still refused with the same record.
      const again = await book('O34', 'W33');
      expect(again.status).toBe(409);
      expect(again.body.existing).toEqual(record);

      const res = await undo('O34');
      expect(res.status).toBe(200);
      const back = await searchFile();
      const o34After = byId(back.openings).get('O34')!;
      expect(o34After.filled).toBeNull();
      expect(o34After.cards).toEqual(o34Before.cards);
      expect(ids(o34After)).toContain(AMANDA.newest);
      const nums = ids(o34After).map(lineNo);
      expect(nums).toEqual([...nums].sort((a, b) => a - b));
      expect(back.openings).toEqual(original.openings);
      expect(back.resultsCsv).toBe(cliCsv);
    },
    TIMEOUT,
  );
});

// ---- privacy (runs last: scans every JSON body this file saw) -----------------------------------------------

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

/** Every opening view inside a search or file-search body. */
const viewsIn = (body: any): OpeningView[] => [...(body.opening ? [body.opening] : []), ...(body.openings ?? [])];

describe('8. privacy', () => {
  it('every JSON body from search, search/file, booked and admin: no health words, no note text; cards carry only name, phone, tel and line', () => {
    const notes = parseWaitlist(
      withRows(sampleText(NAMES.waitlist), ['61,10/20,Odile Comeau,506-555-0199,any - 60 - not Mon']),
      RUN_YEAR,
    )
      .map((l) => l.notes.trim())
      .filter((t) => t !== '');
    expect(notes.length).toBeGreaterThan(50);
    // The scan bites: the waitlist itself has health words.
    expect(healthHits(sampleText(NAMES.waitlist)).length).toBeGreaterThan(3);

    const labels = new Set(seen.map((s) => s.label));
    expect([...labels].sort()).toEqual(['admin', 'booked', 'search', 'search/file']);
    expect(seen.length).toBeGreaterThan(100);

    let cards = 0;
    for (const { label, text, body } of seen) {
      expect(healthHits(text), `${label}: health words`).toEqual([]);
      const strings = stringsIn(body);
      for (const note of notes) {
        expect(strings.find((s) => s.includes(note)), `${label}: contains the note "${note}"`).toBeUndefined();
      }
      expect(text).not.toContain('"notes"');
      if (label !== 'search' && label !== 'search/file') continue;
      for (const v of viewsIn(body)) {
        for (const c of v.cards) {
          cards++;
          expect(Object.keys(c).sort(), `${label} ${v.id}`).toEqual(['lineId', 'n', 'name', 'phone', 'tel']);
          expect(c.lineId).toMatch(/^W\d+$/);
          expect(c.phone).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
          expect(c.tel).toBe(telHref(c.phone));
        }
        if (v.filled) expect(Object.keys(v.filled).sort()).toEqual(['at', 'atText', 'lineId', 'name']);
      }
    }
    expect(cards).toBeGreaterThan(200);
  });
});
