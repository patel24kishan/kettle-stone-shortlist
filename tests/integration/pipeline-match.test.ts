// Integration: Feature 1 (import) + Feature 2 (note reader) + Feature 3 (matcher), files to suggestions.
// Raw CSV text -> column check -> parse -> group -> readAll (saved readings / mocked Claude) -> buildPeople
// -> matchAll over the late openings -> compared with Tanya's answer key.
// Expected behaviour: ../rules.md (Steps 1-4, "Always", "Still to decide") and ../build-plan.md sections 1
// (how Friday is scored), 5.3-5.4 and 6 Steps 1-3. The real API is never called; sample files are never
// modified (every test works on temp copies).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { checkColumns, parseAppointments, parseCsv, parseOpenings, parseWaitlist } from '@/lib/csv';
import { buildPeople, groupLines } from '@/lib/import';
import type { BuildPeopleResult } from '@/lib/import';
import { CHECKS } from '@/lib/rules';
import { MAX_SUGGESTIONS, NOBODY_REASON, NO_SHOW_REASON, matchAll, passingIds } from '@/lib/match';
import { FileReadingCache } from '@/lib/readings/cache';
import type { ReadingCacheEntry } from '@/lib/readings/cache';
import { makeGetReading, readAll } from '@/lib/readings/reader';
import type { ReadResult } from '@/lib/readings/reader';
import { defaultReading } from '@/lib/readings/schema';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { BookedRecord, Opening, OpeningResult, Reading, Settings, WaitlistLine } from '@/lib/types';

const RUN_DATE = '2026-10-21';
const RUN_YEAR = 2026;
const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const WAITLIST_FILE = 'waitlist-2026-10-21.csv';
const APPTS_FILE = 'appointments-2026-09-21-to-2026-10-17.csv';
const OPENINGS_FILE = 'late-openings-2026-09-21-to-2026-10-17.csv';
const READINGS_FILE = 'readings.json';
const sampleText = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');

const WAITLIST_TEXT = sampleText(WAITLIST_FILE);
const APPTS_TEXT = sampleText(APPTS_FILE);
const OPENINGS_TEXT = sampleText(OPENINGS_FILE);
const SAVED_READINGS = JSON.parse(sampleText(READINGS_FILE)) as Record<string, ReadingCacheEntry>;

/** The key's answer per opening: line ids in the key's order ([] for "none"). */
const KEY: Record<string, string[]> = {};
for (const row of parseCsv(sampleText('answer-key-tanya.csv')).filter((r) => r.type === 'opening')) {
  KEY[row.id!] = row.answer === 'none' ? [] : row.answer!.split('; ').map((s) => s.split(' ')[0]!);
}

// Fingerprints of the sample files, to prove no test touched them.
const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(path.join(SAMPLE, f)));

// ---- temp dirs -----------------------------------------------------------------------------------------
let TMP = '';
let counter = 0;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-pipeline-match-'));
});
afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(path.join(SAMPLE, f)).equals(bytes), f).toBe(true);
  expect(fs.readdirSync(SAMPLE).sort()).toEqual([...sampleBytes.keys()].sort());
});

interface Workspace {
  readingsPath: string;
  waitlistText: string;
  openingsText: string;
}

/** A fresh folder: a copy of readings.json, the waitlist (optionally with rows appended) and an openings file. */
function workspace(extraRows: string[] = [], openingsText: string = OPENINGS_TEXT): Workspace {
  const dir = path.join(TMP, `ws-${++counter}`);
  fs.mkdirSync(dir);
  const readingsPath = path.join(dir, READINGS_FILE);
  fs.copyFileSync(path.join(SAMPLE, READINGS_FILE), readingsPath);
  const waitlistPath = path.join(dir, WAITLIST_FILE);
  // The sample file ends with CRLF; appended rows follow the same style.
  fs.writeFileSync(waitlistPath, WAITLIST_TEXT + extraRows.map((r) => `${r}\r\n`).join(''), 'utf8');
  const openingsPath = path.join(dir, 'late-openings.csv');
  fs.writeFileSync(openingsPath, openingsText, 'utf8');
  return {
    readingsPath,
    waitlistText: fs.readFileSync(waitlistPath, 'utf8'),
    openingsText: fs.readFileSync(openingsPath, 'utf8'),
  };
}

// ---- mocked Anthropic client (same shape as import-and-read.test.ts) ----------------------------------
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

/** A client whose reply is chosen by the line ids it was sent. An unexpected group fails the test. */
function mockClient(replies: Record<string, unknown>) {
  const create = vi.fn(async (p: MessageCreateParamsNonStreaming) => {
    const ids = idsIn(p).join(',');
    if (!(ids in replies)) throw new Error(`unexpected Claude call for ${ids}`);
    return message(JSON.stringify(replies[ids]));
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, create };
}

// ---- the pipeline --------------------------------------------------------------------------------------
interface Run {
  lines: WaitlistLine[];
  groups: WaitlistLine[][];
  read: Map<string, ReadResult>;
  built: BuildPeopleResult;
  readings: Map<string, Reading | null>;
  openings: Opening[];
  results: OpeningResult[];
}

interface RunOptions {
  extraRows?: string[];
  openingsText?: string;
  client?: Anthropic | null;
  booked?: BookedRecord[];
  settings?: Settings;
}

async function pipeline(o: RunOptions = {}): Promise<Run> {
  const ws = workspace(o.extraRows, o.openingsText);
  expect(checkColumns(ws.waitlistText, 'waitlist').ok).toBe(true);
  expect(checkColumns(APPTS_TEXT, 'appointments').ok).toBe(true);
  expect(checkColumns(ws.openingsText, 'openings').ok).toBe(true);

  const lines = parseWaitlist(ws.waitlistText, RUN_YEAR);
  const appointments = parseAppointments(APPTS_TEXT);
  const groups = groupLines(lines);
  const read = await readAll(groups, {
    cache: new FileReadingCache(ws.readingsPath),
    client: o.client ?? null,
    runYear: RUN_YEAR,
    now: () => new Date('2026-10-29T10:00:00Z'),
  });
  const built = buildPeople(lines, {
    runDate: RUN_DATE,
    appointments,
    getReading: makeGetReading(read, groups),
    booked: o.booked,
  });
  const readings = new Map([...read.entries()].map(([k, r]) => [k, r.reading]));
  const openings = parseOpenings(ws.openingsText);
  const results = matchAll(openings, built.people, readings, o.settings ?? DEFAULT_SETTINGS);
  return { lines, groups, read, built, readings, openings, results };
}

const shown = (r: OpeningResult) => r.suggestions.map((s) => s.lineId);
const byId = (run: Run, id: string) => run.results.find((r) => r.openingId === id)!;
const traceOf = (r: OpeningResult, lineId: string) => r.trace.find((t) => t.lineId === lineId);
const allPassed = (checks: { pass: boolean }[]) => checks.length === CHECKS.length && checks.every((c) => c.pass);

/** build-plan section 1 and 6 Step 3: the three scores against the key. */
function score(results: OpeningResult[]) {
  let friday = 0;
  let first3 = 0;
  let full = 0;
  const fridayWrong: string[] = [];
  for (const r of results) {
    const key = KEY[r.openingId]!;
    const names = shown(r);
    const fridayOk = names.length ? names.every((id) => key.includes(id)) : key.length === 0;
    if (fridayOk) friday++;
    else fridayWrong.push(r.openingId);
    if (names.join() === key.slice(0, MAX_SUGGESTIONS).join()) first3++;
    if (passingIds(r).join() === key.join()) full++;
  }
  return { friday, first3, full, fridayWrong };
}

// ---- data used below -----------------------------------------------------------------------------------
const AMANDA_DIGITS = '5065550125';
const AMANDA_BOOKED: BookedRecord = {
  personPhoneDigits: AMANDA_DIGITS,
  personName: 'Amanda Bourgeois',
  lineId: 'W42',
  openingId: 'O34',
  at: '2026-10-14T09:30:00.000Z',
  by: 'local',
};

const NEW_NAME = 'Odile Comeau';
const NEW_PHONE = '506-555-0199';
const NEW_LINE = `61,10/21,${NEW_NAME},${NEW_PHONE},any - 60`;

/** A clean reading of "any - 60" on W61: any therapist, 60, any day (defaults elsewhere). */
function cleanNewReading(): Reading {
  const r = defaultReading();
  r.lengths = { value: { minutes: [60], only: false }, source: [{ lineId: 'W61', text: '60' }] };
  return r;
}

/** Amanda's saved reading (W26 + W42), reused for a group that adds a newer line. */
function amandaSavedReading(): Reading {
  const entry = Object.values(SAVED_READINGS).find((e) =>
    e.reading.therapistsAllowed.source.some((q) => q.lineId === 'W42'),
  )!;
  return structuredClone(entry.reading);
}

/** Every opening fits "any - 60" when it is a late cancel of 60+ minutes with 2+ hours of notice. */
const fitsAny60 = (o: Opening) => o.kind === 'late cancel' && o.length_min >= 60 && o.hours_notice >= 2;

// =========================================================================================================

let BASE: Run;
beforeAll(async () => {
  BASE = await pipeline();
});

describe('1. whole sample, files to suggestions (saved readings, no Claude)', () => {
  it('44 openings; 45 people all read from the cache; Friday 44/44, first 3 44/44, full list 44/44', () => {
    expect(checkColumns(OPENINGS_TEXT, 'openings')).toEqual({ ok: true, missing: [], rows: 44 });
    expect(BASE.lines).toHaveLength(60);
    expect(BASE.groups).toHaveLength(45);
    expect([...BASE.read.values()].every((r) => r.status === 'cached')).toBe(true);
    expect(BASE.openings).toHaveLength(44);
    expect(BASE.results.map((r) => r.openingId)).toEqual(Object.keys(KEY));

    const s = score(BASE.results);
    const fullWrong = BASE.results
      .filter((r) => passingIds(r).join() !== KEY[r.openingId]!.join())
      .map((r) => `${r.openingId}: ours=${passingIds(r).join(' ') || 'none'} key=${KEY[r.openingId]!.join(' ') || 'none'}`);
    expect(fullWrong).toEqual([]);
    expect(s.fridayWrong).toEqual([]);
    expect(s).toMatchObject({ friday: 44, first3: 44, full: 44 });
  });

  it('34 openings have names and 10 have nobody (8 no-shows + O31, O40), each with the right reason', () => {
    const named = BASE.results.filter((r) => r.suggestions.length > 0);
    const nobody = BASE.results.filter((r) => r.suggestions.length === 0);
    expect(named).toHaveLength(34);
    expect(nobody).toHaveLength(10);
    for (const r of named) expect(r.nobodyReason).toBeNull();
    const noShowIds = BASE.openings.filter((o) => o.kind === 'no-show').map((o) => o.opening_id);
    expect(noShowIds).toHaveLength(8);
    for (const r of nobody) {
      expect(r.nobodyReason).toBe(noShowIds.includes(r.openingId) ? NO_SHOW_REASON : NOBODY_REASON);
    }
    expect(nobody.filter((r) => r.nobodyReason === NOBODY_REASON).map((r) => r.openingId)).toEqual(['O31', 'O40']);
  });

  it('suggestions carry only line id, name and phone, at most 3, in waitlist order', () => {
    for (const r of BASE.results) {
      expect(r.suggestions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
      const ns = r.suggestions.map((s) => Number(s.lineId.slice(1)));
      expect([...ns].sort((a, b) => a - b)).toEqual(ns);
      for (const s of r.suggestions) {
        expect(Object.keys(s).sort()).toEqual(['lineId', 'name', 'phoneDisplay']);
        expect(s.phoneDisplay).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
      }
    }
  });
});

describe('2. booked through the tool takes a person out of every opening (rules.md Step 2)', () => {
  it('Amanda (W42) booked for O34 on Oct 14: in no suggestions or passing list; everyone else unchanged', async () => {
    const run = await pipeline({ booked: [AMANDA_BOOKED] });

    const amanda = run.built.people.find((p) => p.key === 'W42')!;
    expect(amanda.lineIds).toEqual(['W26', 'W42']);
    expect(amanda.tags).toEqual([
      { kind: 'booked', reason: 'Booked through the tool for O34 on Oct 14.', openingId: 'O34', at: AMANDA_BOOKED.at },
    ]);
    // A tag covers the person: all their lines carry it (kept, never deleted).
    expect(run.built.verdicts.W26).toBe('stale');
    expect(run.built.verdicts.W42).toBe('stale');
    expect(run.built.reasons.W42).toMatch(/Booked through the tool for O34/);
    expect(Object.keys(run.built.verdicts)).toHaveLength(60);

    // She was in some baseline lists, including the first 3 of several openings.
    const hadHer = BASE.results.filter((r) => passingIds(r).includes('W42')).map((r) => r.openingId);
    expect(hadHer.length).toBeGreaterThan(10);
    expect(BASE.results.filter((r) => shown(r).includes('W42')).length).toBeGreaterThan(5);

    run.results.forEach((r, i) => {
      const base = BASE.results[i]!;
      expect(r.openingId).toBe(base.openingId);
      expect(shown(r)).not.toContain('W42');
      expect(passingIds(r)).not.toContain('W42');
      // Passing list = baseline minus W42, order kept; suggestions = its first 3.
      const expected = passingIds(base).filter((id) => id !== 'W42');
      expect(passingIds(r), r.openingId).toEqual(expected);
      expect(shown(r), r.openingId).toEqual(expected.slice(0, MAX_SUGGESTIONS));
      const wasNoShow = base.nobodyReason === NO_SHOW_REASON;
      expect(r.nobodyReason).toBe(wasNoShow ? NO_SHOW_REASON : expected.length ? null : NOBODY_REASON);
      // Every other person's trace is untouched.
      expect(r.trace.filter((t) => t.lineId !== 'W42')).toEqual(base.trace.filter((t) => t.lineId !== 'W42'));
      // Amanda fails at the tag check with the booked reason (no-shows have no trace).
      const t = traceOf(r, 'W42');
      if (base.trace.length) {
        expect(t!.checks.at(-1)).toEqual({
          check: 'notTagged',
          pass: false,
          reason: 'Not on the active list: Booked through the tool for O34 on Oct 14.',
        });
      }
    });

    // The two openings named in the brief, against the key's full lists with W42 removed.
    expect(shown(byId(run, 'O34'))).toEqual(KEY.O34!.filter((id) => id !== 'W42').slice(0, 3));
    expect(shown(byId(run, 'O34'))).toEqual(['W33', 'W48', 'W49']);
    expect(passingIds(byId(run, 'O34'))).toEqual(['W33', 'W48', 'W49', 'W51', 'W53', 'W60']);
    expect(shown(byId(run, 'O35'))).toEqual(KEY.O35!.filter((id) => id !== 'W42').slice(0, 3));
    expect(shown(byId(run, 'O35'))).toEqual(['W49', 'W53']);
    // Every other person's verdicts are unchanged.
    for (const id of Object.keys(BASE.built.verdicts)) {
      if (id === 'W26' || id === 'W42') continue;
      expect(run.built.verdicts[id], id).toBe(BASE.built.verdicts[id]);
    }
  });

  it('a no-booking run is the baseline (test runs start with no Booked marks)', async () => {
    const run = await pipeline({ booked: [] });
    expect(run.results).toEqual(BASE.results);
  });

  it('a newer waitlist line from Amanda, dated after the booking, lifts the tag: she is suggested again', async () => {
    const { client, create } = mockClient({ 'W26,W42,W61': amandaSavedReading() });
    const run = await pipeline({
      extraRows: ['61,10/20,Amanda Bourgeois,506-555-0125,still R/J - 1hr'],
      client,
      booked: [AMANDA_BOOKED],
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(run.read.get('W61')).toMatchObject({ status: 'claude', problems: [] });

    const amanda = run.built.people.find((p) => p.key === 'W61')!;
    expect(amanda).toMatchObject({ lineIds: ['W26', 'W42', 'W61'], newestId: 'W61', tags: [] });
    expect(run.built.verdicts.W61).toBe('active');
    expect(run.built.verdicts.W42).toBe('duplicate of W61');

    // Her place on the list is now line 61: she is at the end of every passing list she was in.
    run.results.forEach((r, i) => {
      const base = passingIds(BASE.results[i]!);
      const expected = base.includes('W42') ? [...base.filter((id) => id !== 'W42'), 'W61'] : base;
      expect(passingIds(r), r.openingId).toEqual(expected);
      expect(shown(r), r.openingId).toEqual(expected.slice(0, MAX_SUGGESTIONS));
    });
    expect(shown(byId(run, 'O18'))).toEqual(['W20', 'W61']);
    expect(shown(byId(run, 'O32'))).toEqual(['W49', 'W61']);
    expect(shown(byId(run, 'O35'))).toEqual(['W49', 'W53', 'W61']);
    expect(byId(run, 'O35').suggestions[2]).toEqual({ lineId: 'W61', name: 'Amanda Bourgeois', phoneDisplay: '(506) 555-0125' });
  });
});

describe('3. a person whose notes were not read is never suggested', () => {
  it('a new "any - 60" line with no client: status "not read", in no list; every sample result otherwise unchanged', async () => {
    const run = await pipeline({ extraRows: [NEW_LINE], client: null });
    expect(run.read.get('W61')).toMatchObject({ status: 'not read', reading: null });
    expect(run.built.people.find((p) => p.key === 'W61')).toMatchObject({ name: NEW_NAME, tags: [] });

    // They would fit plenty of openings if read.
    expect(BASE.openings.filter(fitsAny60).length).toBeGreaterThan(20);

    run.results.forEach((r, i) => {
      const base = BASE.results[i]!;
      expect(shown(r)).not.toContain('W61');
      expect(passingIds(r)).not.toContain('W61');
      expect(r.suggestions).toEqual(base.suggestions);
      expect(r.nobodyReason).toBe(base.nobodyReason);
      expect(r.joseeNote).toBe(base.joseeNote);
      expect(r.trace.filter((t) => t.lineId !== 'W61')).toEqual(base.trace);
      if (base.trace.length) {
        expect(traceOf(r, 'W61')!.checks.at(-1)).toEqual({ check: 'hasReading', pass: false, reason: 'Notes not read yet.' });
      }
    });
  });
});

describe('4. an unclear reading is never suggested; a clean one is, in waitlist order', () => {
  it('Claude flags part of the notes unclear: never suggested, fails at the unclear check', async () => {
    const r = cleanNewReading();
    r.unclear = [{ lineId: 'W61', text: '', affects: ['time'] }];
    const { client } = mockClient({ W61: r });
    const run = await pipeline({ extraRows: [NEW_LINE], client });
    expect(run.read.get('W61')!.status).toBe('claude');
    expect(run.read.get('W61')!.reading!.unclear).toEqual([{ lineId: 'W61', text: '', affects: ['time'] }]);

    run.results.forEach((res, i) => {
      expect(passingIds(res)).not.toContain('W61');
      expect(res.suggestions).toEqual(BASE.results[i]!.suggestions);
    });
    const o01 = traceOf(byId(run, 'O01'), 'W61')!;
    expect(o01.checks.at(-1)).toEqual({ check: 'unclear', pass: false, reason: 'Notes unclear about time.' });
  });

  it('a quote that fails validation (not in the notes) makes the field unclear: never suggested', async () => {
    const r = cleanNewReading();
    r.startEarliest = { value: '17:00', source: [{ lineId: 'W61', text: 'after 5' }] }; // not in "any - 60"
    const { client } = mockClient({ W61: r });
    const run = await pipeline({ extraRows: [NEW_LINE], client });
    const res = run.read.get('W61')!;
    expect(res.status).toBe('claude');
    expect(res.problems.join(' ')).toMatch(/startEarliest/);
    expect(res.reading!.startEarliest).toEqual({ value: null, source: [] }); // never guessed
    expect(res.reading!.unclear.flatMap((u) => u.affects)).toContain('time');

    run.results.forEach((x, i) => {
      expect(passingIds(x)).not.toContain('W61');
      expect(x.suggestions).toEqual(BASE.results[i]!.suggestions);
    });
  });

  it('a clean reading (any therapist, 60, any day): in the passing lists of the openings they fit, after everyone else', async () => {
    const { client, create } = mockClient({ W61: cleanNewReading() });
    const run = await pipeline({ extraRows: [NEW_LINE], client });
    expect(create).toHaveBeenCalledTimes(1);
    expect(run.read.get('W61')).toMatchObject({ status: 'claude', problems: [] });

    let fits = 0;
    run.results.forEach((r, i) => {
      const base = passingIds(BASE.results[i]!);
      const opening = run.openings[i]!;
      const expected = fitsAny60(opening) ? [...base, 'W61'] : base;
      if (fitsAny60(opening)) fits++;
      expect(passingIds(r), r.openingId).toEqual(expected);
      expect(shown(r), r.openingId).toEqual(expected.slice(0, MAX_SUGGESTIONS));
      // Line 61 is the last line on the list, so the order never puts them ahead of anyone.
      if (passingIds(r).includes('W61')) expect(passingIds(r).at(-1)).toBe('W61');
    });
    expect(fits).toBeGreaterThan(20);
    // Openings with fewer than 3 names now show them; O13 (30 min), O31 and O40 (under 2 h notice) do not.
    expect(shown(byId(run, 'O30'))).toEqual(['W46', 'W61']);
    expect(shown(byId(run, 'O10'))).toEqual(['W46', 'W57', 'W61']);
    for (const id of ['O13', 'O31', 'O40']) expect(passingIds(byId(run, id))).not.toContain('W61');
    expect(shown(byId(run, 'O31'))).toEqual([]);
    expect(byId(run, 'O30').suggestions[1]).toEqual({ lineId: 'W61', name: NEW_NAME, phoneDisplay: '(506) 555-0199' });
  });
});

describe('5. the waitlist as it stands on the run date', () => {
  it('Lise Gautreau (W57, added Oct 13) is in O01 (Sep 21)\'s passing list and suggestions', () => {
    const lise = BASE.built.people.find((p) => p.key === 'W57')!;
    expect(lise).toMatchObject({ name: 'Lise Gautreau', newestDate: '2026-10-13', tags: [] });
    const o01 = byId(BASE, 'O01');
    expect(BASE.openings[0]!.date).toBe('2026-09-21');
    expect(passingIds(o01)).toContain('W57');
    expect(passingIds(o01)).toEqual(['W39', 'W42', 'W45', 'W57']);
    // Pauline's Oct 8 line ("Mon or Wed AM only now") applies to the Sep 23 opening O05 (11:45 Wed).
    expect(passingIds(byId(BASE, 'O05'))).toContain('W51');
  });
});

describe('6. Friday-style new openings (dated after the run date)', () => {
  const HEADER =
    'opening_id,appointment_id,date,day,start,length_min,therapist,kind,cancelled_at,hours_notice,heard_via,client_had_confirmed,refilled,refilled_how,booked_value_cad';
  const FRIDAY_OPENINGS = [
    HEADER,
    'N01,A-30001,2026-10-26,Mon,12:30,60,Josée Landry,late cancel,2026-10-26 09:00,3.5,phone,yes (text),no,,115',
    'N02,A-30002,2026-10-27,Tue,17:30,60,Dave Melanson,late cancel,2026-10-27 16:30,1.0,phone,no,no,,115',
    'N03,A-30003,2026-10-28,Wed,11:00,60,Rachel Thibodeau,no-show,2026-10-28 11:15,0.0,no-show,no,no,,115',
  ].join('\r\n') + '\r\n';

  it('column check passes; no-show gets the no-show reason; Josée note set; waitlist order; precision rule holds', async () => {
    expect(checkColumns(FRIDAY_OPENINGS, 'openings')).toEqual({ ok: true, missing: [], rows: 3 });
    const run = await pipeline({ openingsText: FRIDAY_OPENINGS });
    expect(run.results.map((r) => r.openingId)).toEqual(['N01', 'N02', 'N03']);
    const [josee, dave, noShow] = run.results as [OpeningResult, OpeningResult, OpeningResult];

    // Josée, Mon 12:30, 60, 3.5 h: like O01, plus Chantal (needs 3 h) and Luc (back from Oct 10).
    expect(josee.joseeNote).toBe(true);
    expect(passingIds(josee)).toEqual(['W14', 'W39', 'W42', 'W45', 'W53', 'W57']);
    expect(shown(josee)).toEqual(['W14', 'W39', 'W42']);
    expect(josee.nobodyReason).toBeNull();

    // Dave, Tue 17:30, 1 hour's notice: only Jordan (W59, "can come in an hour", Mon/Tue after 5).
    expect(dave.joseeNote).toBe(false);
    expect(shown(dave)).toEqual(['W59']);
    expect(traceOf(dave, 'W47')!.checks.at(-1)).toMatchObject({ check: 'notice', pass: false });

    // The no-show: nobody, with the no-show reason, no trace.
    expect(noShow).toEqual({ openingId: 'N03', suggestions: [], nobodyReason: NO_SHOW_REASON, joseeNote: false, trace: [] });

    for (const r of run.results) {
      // Waitlist order.
      const ns = r.suggestions.map((s) => Number(s.lineId.slice(1)));
      expect([...ns].sort((a, b) => a - b)).toEqual(ns);
      // Precision: every suggestion passes every check in its trace, and is an active person with a reading.
      for (const s of r.suggestions) {
        const t = traceOf(r, s.lineId)!;
        expect(t.checks).toHaveLength(CHECKS.length);
        expect(allPassed(t.checks), `${r.openingId} ${s.lineId}`).toBe(true);
        const p = run.built.people.find((x) => x.newestId === s.lineId)!;
        expect(p.tags).toEqual([]);
        expect(run.readings.get(p.key)).not.toBeNull();
      }
      // The suggestions are the first 3 of the people whose whole trace passed.
      expect(shown(r)).toEqual(passingIds(r).slice(0, MAX_SUGGESTIONS));
    }
  });
});

describe('7. determinism', () => {
  it('two full runs from fresh copies give deep-equal OpeningResult[]', async () => {
    const a = await pipeline();
    const b = await pipeline();
    expect(b.results).toEqual(a.results);
    expect(a.results).toEqual(BASE.results);
    expect(JSON.stringify(b.results)).toBe(JSON.stringify(a.results));
  });
});

describe('8. no health details in any output', () => {
  const HEALTH = [
    'pregnant', 'pregnancy', 'surgery', 'post-op', 'MVA', 'sciatica', 'cancer', 'fibro', 'concussion', 'migraine',
    'TMJ', 'knee', 'hip', 'hamstring', 'rotator', 'shoulder',
  ];
  const healthRe = new RegExp(`(^|[^a-z0-9])(${HEALTH.map((w) => w.replace(/-/g, '\\-')).join('|')})(?=$|[^a-z0-9])`, 'i');

  function outputs(run: Run): string[] {
    return [
      ...run.results.map((r) => JSON.stringify(r)),
      ...Object.values(run.built.reasons),
      ...run.built.people.flatMap((p) => p.tags.map((t) => t.reason)),
    ];
  }

  async function runs(): Promise<Run[]> {
    const { client } = mockClient({ W61: cleanNewReading() });
    return [
      BASE,
      await pipeline({ booked: [AMANDA_BOOKED] }),
      await pipeline({ extraRows: [NEW_LINE], client }),
      await pipeline({ settings: { noticeFrom: 'desk_free', allowLongerOpening: false, noticeEqualIsEnough: false } }),
    ];
  }

  it('the health-word pattern is live (it catches the words in the raw notes)', () => {
    const notes = BASE.lines.map((l) => l.notes);
    expect(notes.filter((n) => healthRe.test(n)).length).toBeGreaterThan(8);
    expect(healthRe.test('post-op shoulder')).toBe(true);
    expect(healthRe.test('Chiasson, Philippe')).toBe(false);
  });

  it('no suggestion, nobody reason, trace reason, import reason or tag reason contains a health word', async () => {
    for (const run of await runs()) {
      const texts = [
        ...run.results.flatMap((r) => [
          JSON.stringify(r.suggestions),
          r.nobodyReason ?? '',
          ...r.trace.flatMap((t) => t.checks.map((c) => c.reason)),
        ]),
        ...Object.values(run.built.reasons),
        ...run.built.people.flatMap((p) => p.tags.map((t) => t.reason)),
      ];
      expect(texts.filter((s) => healthRe.test(s))).toEqual([]);
    }
  });

  // Was a real bug (check id "pregnancy" plus a person-specific pass reason singled out W10/W40); fixed by renaming
  // the check to "clinicRule" with one pass reason for everyone. rules.md Step 1 and "Always".
  it('the whole serialised OpeningResult (trace check ids included) contains no health word', async () => {
    for (const run of await runs()) {
      const hits = [...new Set(outputs(run).filter((s) => healthRe.test(s)).map((s) => s.match(healthRe)![2]!.toLowerCase()))];
      expect(hits, 'health words found in serialised OpeningResult / reasons').toEqual([]);
    }
  });

  it('a passing clinic-rule check reads the same for everyone, so no trace singles out W10 or W40', () => {
    for (const o of BASE.results) {
      const passReasons = new Set(
        o.trace.flatMap((t) => t.checks.filter((c) => c.check === 'clinicRule' && c.pass).map((c) => c.reason)),
      );
      expect(passReasons.size, o.openingId).toBeLessThanOrEqual(1);
    }
    const o24 = byId(BASE, 'O24'); // Amira, Mon 14:45, 60: W10 and W40 pass like everyone else
    const passed = o24.trace.filter((t) => t.checks.some((c) => c.check === 'clinicRule' && c.pass)).map((t) => t.lineId);
    expect(passed).toEqual(expect.arrayContaining(['W10', 'W40']));
  });

  it('no output contains raw note text from the waitlist', async () => {
    const notes = BASE.lines.map((l) => l.notes.trim());
    // Whole notes, plus every note fragment of 10+ characters (split on the " - ", ", " and ". " separators).
    const fragments = new Set<string>(notes.filter((n) => n.length >= 6));
    for (const n of notes) {
      for (const f of n.split(/ - |, |\. |; /)) if (f.trim().length >= 10) fragments.add(f.trim());
    }
    expect(fragments.size).toBeGreaterThan(60);
    for (const run of await runs()) {
      const all = outputs(run).join('\n');
      const found = [...fragments].filter((f) => all.includes(f));
      expect(found).toEqual([]);
    }
  });
});

describe('9. settings flow end to end', () => {
  it('allowLongerOpening: false drops the Friday score below 44 (the key relies on it); defaults give 44', async () => {
    const strict = await pipeline({ settings: { ...DEFAULT_SETTINGS, allowLongerOpening: false } });
    const s = score(strict.results);
    expect(s.friday).toBeLessThan(44);
    // The 90-minute Kelsey openings are taken only by people who asked for 60.
    expect(s.fridayWrong).toEqual(expect.arrayContaining(['O03', 'O27']));
    expect(shown(byId(strict, 'O03'))).toEqual([]);
    expect(byId(strict, 'O03').nobodyReason).toBe(NOBODY_REASON);
    expect(s.first3).toBeLessThan(44);
    expect(s.full).toBeLessThan(44);
    // Stricter never adds a name: every passing list is a subset of the default one.
    strict.results.forEach((r, i) => {
      const was = new Set(passingIds(BASE.results[i]!));
      for (const id of passingIds(r)) expect(was.has(id)).toBe(true);
    });

    const defaults = await pipeline({ settings: { ...DEFAULT_SETTINGS } });
    expect(score(defaults.results)).toMatchObject({ friday: 44, first3: 44, full: 44 });
    expect(defaults.results).toEqual(BASE.results);
  });
});
