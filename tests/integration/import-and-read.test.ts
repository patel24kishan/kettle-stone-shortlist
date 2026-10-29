// Integration: Feature 1 (import and clean) + Feature 2 (note reader), end to end.
// Raw CSV text -> column check -> parse -> group -> readAll (cache / mocked Claude) -> buildPeople.
// Expected behaviour: ../build-plan.md sections 2, 4 ("Claude reads, code picks"), 6 Steps 1-2 and
// ../rules.md Steps 1-2 and "Always". The real API is never called; sample files are never modified
// (every test works on temp copies).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Papa from 'papaparse';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { checkColumns, parseAppointments, parseCsv, parseWaitlist } from '@/lib/csv';
import { buildPeople, groupLines } from '@/lib/import';
import type { BuildPeopleResult } from '@/lib/import';
import type { Reading, WaitlistLine } from '@/lib/types';
import { FileReadingCache } from '@/lib/readings/cache';
import type { ReadingCacheEntry } from '@/lib/readings/cache';
import { readingKey } from '@/lib/readings/hash';
import { makeGetReading, readAll } from '@/lib/readings/reader';
import type { ReadResult } from '@/lib/readings/reader';
import { defaultReading } from '@/lib/readings/schema';

const RUN_DATE = '2026-10-21';
const RUN_YEAR = 2026;
const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const WAITLIST_FILE = 'waitlist-2026-10-21.csv';
const APPTS_FILE = 'appointments-2026-09-21-to-2026-10-17.csv';
const READINGS_FILE = 'readings.json';
const sampleText = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');

const WAITLIST_TEXT = sampleText(WAITLIST_FILE);
const APPTS_TEXT = sampleText(APPTS_FILE);
const ANSWER_KEY = parseCsv(sampleText('answer-key-tanya.csv')).filter((r) => r.type === 'waitlist line');

// Fingerprints of the sample files, to prove no test touched them.
const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(path.join(SAMPLE, f)));

// ---- temp dirs -----------------------------------------------------------------------------------------
let TMP = '';
let counter = 0;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-import-read-'));
});
afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  // The sample folder is exactly as it was.
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(path.join(SAMPLE, f)).equals(bytes), f).toBe(true);
  expect(fs.readdirSync(SAMPLE).sort()).toEqual([...sampleBytes.keys()].sort());
});

/** A fresh folder holding a copy of readings.json and, optionally, an altered waitlist. */
function workspace(extraRows: string[] = []): { dir: string; readingsPath: string; waitlistText: string } {
  const dir = path.join(TMP, `ws-${++counter}`);
  fs.mkdirSync(dir);
  const readingsPath = path.join(dir, READINGS_FILE);
  fs.copyFileSync(path.join(SAMPLE, READINGS_FILE), readingsPath);
  const waitlistPath = path.join(dir, WAITLIST_FILE);
  // The sample file ends with CRLF; appended rows follow the same style.
  fs.writeFileSync(waitlistPath, WAITLIST_TEXT + extraRows.map((r) => `${r}\r\n`).join(''), 'utf8');
  return { dir, readingsPath, waitlistText: fs.readFileSync(waitlistPath, 'utf8') };
}

const entriesIn = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, ReadingCacheEntry>;

// ---- mocked Anthropic client (same shape as tests/unit/readings-reader.test.ts) -----------------------
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

/** A client whose reply is chosen by the line ids it was sent. An unexpected group fails the test. */
function mockClient(replies: Record<string, unknown>) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const create = vi.fn(async (p: MessageCreateParamsNonStreaming) => {
    calls.push(p);
    const ids = idsIn(p).join(',');
    if (!(ids in replies)) throw new Error(`unexpected Claude call for ${ids}`);
    return message(JSON.stringify(replies[ids]));
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, calls, create };
}

// ---- the pipeline --------------------------------------------------------------------------------------
interface Run {
  lines: WaitlistLine[];
  groups: WaitlistLine[][];
  results: Map<string, ReadResult>;
  built: BuildPeopleResult;
}

async function pipeline(waitlistText: string, readingsPath: string, client: Anthropic | null): Promise<Run> {
  expect(checkColumns(waitlistText, 'waitlist').ok).toBe(true);
  expect(checkColumns(APPTS_TEXT, 'appointments').ok).toBe(true);
  const lines = parseWaitlist(waitlistText, RUN_YEAR);
  const appointments = parseAppointments(APPTS_TEXT);
  const groups = groupLines(lines);
  const results = await readAll(groups, {
    cache: new FileReadingCache(readingsPath),
    client,
    runYear: RUN_YEAR,
    now: () => new Date('2026-10-29T10:00:00Z'),
  });
  const built = buildPeople(lines, { runDate: RUN_DATE, appointments, getReading: makeGetReading(results, groups) });
  return { lines, groups, results, built };
}

const statuses = (results: Map<string, ReadResult>) => [...results.values()].map((r) => r.status);
const keyVerdicts = () => Object.fromEntries(ANSWER_KEY.map((k) => [k.id!, k.answer!]));

// ---- appended lines used below -------------------------------------------------------------------------
const NEW_PHONE = '506-555-0199';
const NEW_NAME = 'Odile Comeau';
const NEW_LINE = `61,10/21,${NEW_NAME},${NEW_PHONE},any - 60 - not Mon - after 4`;

/** A valid reading of "any - 60 - not Mon - after 4" on W61. */
function newLineReading(): Reading {
  const r = defaultReading();
  r.lengths = { value: { minutes: [60], only: false }, source: [{ lineId: 'W61', text: '60' }] };
  r.daysExcluded = { value: ['Mon'], source: [{ lineId: 'W61', text: 'not Mon' }] };
  r.startEarliest = { value: '16:00', source: [{ lineId: 'W61', text: 'after 4' }] };
  return r;
}

// =========================================================================================================

describe('1. sample files, offline (saved readings, no Claude)', () => {
  it('CSV text -> column check -> parse -> group -> cached readings -> 60/60 verdicts, 30 active, zero calls', async () => {
    const ws = workspace();
    const before = fs.readFileSync(ws.readingsPath, 'utf8');

    const wl = checkColumns(ws.waitlistText, 'waitlist');
    expect(wl).toEqual({ ok: true, missing: [], rows: 60 });
    expect(checkColumns(APPTS_TEXT, 'appointments')).toMatchObject({ ok: true, missing: [] });

    const run = await pipeline(ws.waitlistText, ws.readingsPath, null);
    expect(run.lines).toHaveLength(60);
    expect(run.groups).toHaveLength(45);
    expect(run.results.size).toBe(45);
    expect(statuses(run.results).every((s) => s === 'cached')).toBe(true);

    // 60/60 against Tanya's answer key.
    expect(ANSWER_KEY).toHaveLength(60);
    const wrong = ANSWER_KEY.filter((k) => run.built.verdicts[k.id!] !== k.answer).map(
      (k) => `${k.id}: ours=${run.built.verdicts[k.id!]} key=${k.answer}`,
    );
    expect(wrong).toEqual([]);
    expect(Object.keys(run.built.verdicts)).toHaveLength(60); // every line kept, none dropped
    expect(run.built.people.filter((p) => p.tags.length === 0)).toHaveLength(30);

    // A cache hit never writes: the temp copy is byte-identical.
    expect(fs.readFileSync(ws.readingsPath, 'utf8')).toBe(before);
  });

  it('with a client present, a fully cached import still makes zero Claude calls', async () => {
    const ws = workspace();
    const { client, create } = mockClient({});
    const run = await pipeline(ws.waitlistText, ws.readingsPath, client);
    expect(create).not.toHaveBeenCalled();
    expect(statuses(run.results).every((s) => s === 'cached')).toBe(true);
  });
});

describe('2. Friday-style new line appended to the waitlist', () => {
  it('with no client: only the new person is "not read", the other 45 stay cached, and the import does not tag them', async () => {
    const ws = workspace([NEW_LINE]);
    const run = await pipeline(ws.waitlistText, ws.readingsPath, null);

    expect(run.groups).toHaveLength(46);
    const notRead = [...run.results.entries()].filter(([, r]) => r.status !== 'cached');
    expect(notRead.map(([id]) => id)).toEqual(['W61']);
    const w61 = run.results.get('W61')!;
    expect(w61.status).toBe('not read');
    expect(w61.reading).toBeNull();
    expect(w61.problems.length).toBeGreaterThan(0);
    expect(statuses(run.results).filter((s) => s === 'cached')).toHaveLength(45);

    // The import does not decide offerability for an unread person (the matcher does, later).
    const person = run.built.people.find((p) => p.key === 'W61')!;
    expect(person).toMatchObject({ lineIds: ['W61'], name: NEW_NAME, phoneDigits: '5065550199', tags: [] });
    expect(run.built.verdicts.W61).toBe('active');

    // The 60 sample lines keep the answer key's verdicts.
    const key = keyVerdicts();
    for (const id of Object.keys(key)) expect(run.built.verdicts[id], id).toBe(key[id]);

    // Nothing was written to the cache file.
    expect(Object.keys(entriesIn(ws.readingsPath))).toHaveLength(45);
  });

  it('with a mocked client: exactly one call, status "claude", 46 entries saved, and a second import makes zero calls', async () => {
    const ws = workspace([NEW_LINE]);
    const { client, create } = mockClient({ W61: newLineReading() });
    const run = await pipeline(ws.waitlistText, ws.readingsPath, client);

    expect(create).toHaveBeenCalledTimes(1);
    const w61 = run.results.get('W61')!;
    expect(w61.status).toBe('claude');
    expect(w61.problems).toEqual([]);
    expect(w61.reading).toEqual(newLineReading());
    expect(statuses(run.results).filter((s) => s === 'cached')).toHaveLength(45);

    const saved = entriesIn(ws.readingsPath);
    expect(Object.keys(saved)).toHaveLength(46);
    const newKey = readingKey(run.groups.find((g) => g[0]!.id === 'W61')!, RUN_YEAR);
    expect(saved[newKey]).toMatchObject({ by: 'claude', readAt: '2026-10-29T10:00:00.000Z', problems: [] });
    expect(Object.keys(saved)).toEqual(Object.keys(saved).sort()); // keys kept sorted

    // Still active: nothing in the reading says they are gone.
    expect(run.built.verdicts.W61).toBe('active');

    // Next import (a new cache object on the same file): everything is cached, no call.
    const again = await pipeline(ws.waitlistText, ws.readingsPath, client);
    expect(create).toHaveBeenCalledTimes(1);
    expect(statuses(again.results).every((s) => s === 'cached')).toBe(true);
    expect(again.results.get('W61')!.reading).toEqual(newLineReading());
  });
});

describe('3. a repeat line for an existing person (Amanda, 506-555-0125)', () => {
  const REPEAT = '61,10/21,Amanda Bourgeois,506-555-0125,still R/J - 1hr';

  it('changes only her group key: one miss, everyone else cached, her newest line becomes W61', async () => {
    const base = workspace();
    const baseRun = await pipeline(base.waitlistText, base.readingsPath, null);
    const ws = workspace([REPEAT]);
    const run = await pipeline(ws.waitlistText, ws.readingsPath, null);

    expect(run.groups).toHaveLength(45); // no new person
    const amanda = run.groups.find((g) => g.some((l) => l.id === 'W61'))!;
    expect(amanda.map((l) => l.id)).toEqual(['W26', 'W42', 'W61']);

    // Keys: only Amanda's changed.
    const baseKeys = new Map([...baseRun.results.values()].map((r) => [r.key, r]));
    const changed = [...run.results.entries()].filter(([, r]) => !baseKeys.has(r.key));
    expect(changed.map(([id]) => id)).toEqual(['W61']);
    expect(run.results.has('W42')).toBe(false);
    expect(run.results.get('W61')!.status).toBe('not read');
    expect(statuses(run.results).filter((s) => s === 'cached')).toHaveLength(44);

    // Verdicts: W61 is the active line, the older two point at it.
    expect(run.built.verdicts.W61).toBe('active');
    expect(run.built.verdicts.W42).toBe('duplicate of W61');
    expect(run.built.verdicts.W26).toBe('duplicate of W61');
    const person = run.built.people.find((p) => p.key === 'W61')!;
    expect(person).toMatchObject({ newestId: 'W61', name: 'Amanda Bourgeois', phoneDisplay: '(506) 555-0125', tags: [] });

    // Every other line keeps the answer key's verdict.
    const key = keyVerdicts();
    for (const id of Object.keys(key)) {
      if (id === 'W26' || id === 'W42') continue;
      expect(run.built.verdicts[id], id).toBe(key[id]);
    }
  });
});

describe('4. a "gone" signal from Claude reaches the import', () => {
  it('gone: "moved" with a valid quote tags the new person stale ("Moved away.") on all their lines', async () => {
    const ws = workspace([
      `61,10/21,${NEW_NAME},${NEW_PHONE},any - 60`,
      '62,10/21,Odile C.,same #,moved to Moncton',
    ]);
    const r = defaultReading();
    r.gone = { value: 'moved', source: [{ lineId: 'W62', text: 'moved to Moncton' }] };
    const { client, create } = mockClient({ 'W61,W62': r });
    const run = await pipeline(ws.waitlistText, ws.readingsPath, client);

    expect(create).toHaveBeenCalledTimes(1);
    const res = run.results.get('W62')!;
    expect(res.status).toBe('claude');
    expect(res.problems).toEqual([]);
    expect(res.reading!.gone.value).toBe('moved');

    const person = run.built.people.find((p) => p.key === 'W62')!;
    expect(person.lineIds).toEqual(['W61', 'W62']);
    expect(person.tags).toEqual([{ kind: 'stale', reason: 'Moved away.' }]);
    expect(run.built.verdicts.W61).toBe('stale');
    expect(run.built.verdicts.W62).toBe('stale');
    expect(run.built.reasons.W61).toBe('Moved away.');
    expect(run.built.reasons.W62).toBe('Moved away.');
  });
});

describe('5. validation sits between Claude and the import', () => {
  it('a quote not in the notes, or containing a health word, resets that field and marks it unclear; nothing is guessed', async () => {
    const ws = workspace([`61,10/21,${NEW_NAME},${NEW_PHONE},any - 60 - knee - not Mon`]);
    const r = defaultReading();
    r.lengths = { value: { minutes: [60], only: false }, source: [{ lineId: 'W61', text: '60' }] }; // fine
    r.daysExcluded = { value: ['Mon'], source: [{ lineId: 'W61', text: 'knee - not Mon' }] }; // health word
    r.startEarliest = { value: '17:00', source: [{ lineId: 'W61', text: 'after 5' }] }; // not in the notes
    r.gone = { value: 'moved', source: [{ lineId: 'W61', text: 'moved away' }] }; // not in the notes
    const { client } = mockClient({ W61: r });
    const run = await pipeline(ws.waitlistText, ws.readingsPath, client);

    const res = run.results.get('W61')!;
    expect(res.status).toBe('claude');
    const reading = res.reading!;
    expect(reading.lengths).toEqual(r.lengths);
    expect(reading.daysExcluded).toEqual({ value: [], source: [] });
    expect(reading.startEarliest).toEqual({ value: null, source: [] });
    expect(reading.gone).toEqual({ value: null, source: [] });
    const topics = reading.unclear.flatMap((u) => u.affects);
    expect(topics).toEqual(expect.arrayContaining(['day', 'time', 'dates']));
    expect(res.problems).toHaveLength(3);
    expect(res.problems.join(' ')).toMatch(/daysExcluded/);
    expect(res.problems.join(' ')).toMatch(/startEarliest/);
    expect(res.problems.join(' ')).toMatch(/gone/);
    // Problems name fields and line ids, never the quoted words (no health details).
    expect(res.problems.join(' ')).not.toMatch(/knee/i);

    // The stored entry matches what was returned, problems included.
    const saved = entriesIn(ws.readingsPath)[res.key]!;
    expect(saved.reading).toEqual(reading);
    expect(saved.problems).toEqual(res.problems);
    expect(JSON.stringify(saved)).not.toMatch(/knee/i);

    // The rejected "moved" never reaches the import: the person is not tagged.
    expect(run.built.people.find((p) => p.key === 'W61')!.tags).toEqual([]);
  });
});

describe('6. determinism', () => {
  it('the same files twice give deep-equal people, verdicts and reasons (offline)', async () => {
    const a = workspace([NEW_LINE]);
    const b = workspace([NEW_LINE]);
    const ra = await pipeline(a.waitlistText, a.readingsPath, null);
    const rb = await pipeline(b.waitlistText, b.readingsPath, null);
    expect(rb.built.people).toEqual(ra.built.people);
    expect(rb.built.verdicts).toEqual(ra.built.verdicts);
    expect(rb.built.reasons).toEqual(ra.built.reasons);
    expect([...rb.results.entries()]).toEqual([...ra.results.entries()]);
  });

  it('a Claude-read run and the cached rerun give the same people, verdicts and reasons', async () => {
    const ws = workspace([NEW_LINE]);
    const { client } = mockClient({ W61: newLineReading() });
    const first = await pipeline(ws.waitlistText, ws.readingsPath, client);
    const second = await pipeline(ws.waitlistText, ws.readingsPath, client);
    expect(second.built).toEqual(first.built);
    expect([...second.results.values()].map((r) => r.reading)).toEqual([...first.results.values()].map((r) => r.reading));
  });
});

describe('7. privacy across the pipeline', () => {
  it('the request bodies Claude receives carry no waitlist names or phone numbers', async () => {
    const ws = workspace([
      NEW_LINE,
      '62,10/21,Amanda Bourgeois,506-555-0125,still R/J - 1hr', // repeat line: Amanda's group is re-read too
    ]);
    const amanda = defaultReading();
    const { client, calls, create } = mockClient({ W61: newLineReading(), 'W26,W42,W62': amanda });
    const run = await pipeline(ws.waitlistText, ws.readingsPath, client);
    expect(create).toHaveBeenCalledTimes(2);

    const body = JSON.stringify(calls);
    for (const l of run.lines) {
      expect(body, l.id).not.toContain(l.name);
      if (l.phoneDigits) {
        expect(body, l.id).not.toContain(l.phone);
        expect(body, l.id).not.toContain(l.phoneDigits);
        expect(body, l.id).not.toContain(run.built.people.find((p) => p.lineIds.includes(l.id))!.phoneDisplay);
      }
    }
    // Only the sent people's line ids, dates and notes are in the user messages.
    for (const c of calls) {
      const user = String(c.messages[0]!.content);
      const sent = JSON.parse(user.split('\n').slice(2).join('\n')) as Record<string, unknown>[];
      for (const s of sent) expect(Object.keys(s).sort()).toEqual(['date', 'lineId', 'notes']);
    }
    // Saved readings never carry names or phones either.
    const saved = fs.readFileSync(ws.readingsPath, 'utf8');
    for (const l of run.lines) {
      expect(saved, l.id).not.toContain(l.name);
      if (l.phoneDigits) expect(saved, l.id).not.toContain(l.phoneDigits);
    }
  });
});

describe('8. the column check refuses a bad file', () => {
  it('a waitlist missing the notes column fails checkColumns and parseWaitlist names the column', () => {
    const rows = parseCsv(WAITLIST_TEXT).map(({ notes: _notes, ...rest }) => rest);
    const dir = path.join(TMP, `bad-${++counter}`);
    fs.mkdirSync(dir);
    const file = path.join(dir, WAITLIST_FILE);
    fs.writeFileSync(file, Papa.unparse(rows, { newline: '\r\n' }), 'utf8');
    const text = fs.readFileSync(file, 'utf8');

    expect(text.split('\r\n')[0]).toBe('line,added,name,phone');
    expect(checkColumns(text, 'waitlist')).toEqual({ ok: false, missing: ['notes'], rows: 60 });
    expect(() => parseWaitlist(text, RUN_YEAR)).toThrow(/notes/);
    expect(() => parseWaitlist(text, RUN_YEAR)).toThrow('The waitlist file is missing column(s): notes.');
  });
});
