// Screen 3 "Today's openings": GET /api/today, called directly with Request objects on a temp store with no
// Claude; the sample is imported through the import route first. Expected behaviour: ../build-plan.md section 6
// Screen 3 (every late opening for the day, up to 3 names each; the same person is not shown for two openings
// once marked Booked for one), section 4 (Booked: save first, one per opening, undo) and ../rules.md Step 4
// (waitlist order) and "Always" (no health details).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as importPOST } from '@/app/api/import/route';
import { POST as fileSearchPOST } from '@/app/api/search/file/route';
import { GET as todayGET } from '@/app/api/today/route';
import { DELETE as bookedDELETE, POST as bookedPOST } from '@/app/api/booked/route';
import { parseCsv, parseOpenings } from '@/lib/csv';
import type { OpeningView } from '@/lib/search-view';
import type { TodayOpeningView } from '@/lib/today-view';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const NAMES = {
  waitlist: 'waitlist-2026-10-21.csv',
  openings: 'late-openings-2026-09-21-to-2026-10-17.csv',
  appointments: 'appointments-2026-09-21-to-2026-10-17.csv',
};
const read = (f: string) => fs.readFileSync(SAMPLE + f, 'utf8');
const csvFile = (text: string, name: string) => new File([text], name, { type: 'text/csv' });
const HEALTH_WORDS = ['pregnant', 'surgery', 'post-op', 'mva', 'sciatica', 'cancer', 'fibro', 'concussion', 'migraine', 'tmj'];

/** Every response body seen in this file, checked for health words at the end. */
const bodies: string[] = [];
async function json(res: Response) {
  const text = await res.text();
  bodies.push(text);
  return JSON.parse(text);
}

function importRequest() {
  const form = new FormData();
  for (const kind of ['waitlist', 'openings', 'appointments'] as const) form.append(kind, csvFile(read(NAMES[kind]), NAMES[kind]));
  form.append('runDate', '2026-10-21');
  return new Request('http://localhost/api/import', { method: 'POST', body: form });
}

const todayReq = (date?: string) => new Request(`http://localhost/api/today${date === undefined ? '' : `?date=${encodeURIComponent(date)}`}`);
const bookReq = (openingId: string, lineId: string) =>
  new Request('http://localhost/api/booked', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ openingId, lineId }),
  });
const undoReq = (openingId: string) =>
  new Request(`http://localhost/api/booked?openingId=${encodeURIComponent(openingId)}`, { method: 'DELETE' });

const names = (o: OpeningView) => o.cards.map((c) => `${c.lineId} ${c.name}`);
const ids = (o: OpeningView) => o.cards.map((c) => c.lineId);
async function day(date: string) {
  const res = await todayGET(todayReq(date));
  expect(res.status).toBe(200);
  return (await json(res)) as {
    ok: true;
    date: string;
    dateLabel: string;
    count: number;
    openings: TodayOpeningView[];
    dates: { first: string | null; last: string | null };
    context: { runDate: string; peopleReady: number; bookingExportDate: string | null; version: number };
  };
}

/** Tanya's list for an opening, as line ids ("W33 W42 ..."), from the answer key. */
function keyList(openingId: string): string[] {
  const row = parseCsv(read('answer-key-tanya.csv')).find((r) => r.id === openingId)!;
  return row.answer === 'none' ? [] : row.answer.split(';').map((s) => s.trim().split(' ')[0]!);
}

let dir: string;
const env = { data: process.env.SHORTLIST_DATA_DIR, noClaude: process.env.SHORTLIST_NO_CLAUDE };
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlist-today-'));
  process.env.SHORTLIST_DATA_DIR = path.join(dir, 'store');
  process.env.SHORTLIST_NO_CLAUDE = '1';
});
afterAll(() => {
  if (env.data === undefined) delete process.env.SHORTLIST_DATA_DIR;
  else process.env.SHORTLIST_DATA_DIR = env.data;
  if (env.noClaude === undefined) delete process.env.SHORTLIST_NO_CLAUDE;
  else process.env.SHORTLIST_NO_CLAUDE = env.noClaude;
  fs.rmSync(dir, { recursive: true, force: true });
});

// The tests in this file run in order on one store.
describe('GET /api/today', () => {
  it('a missing or invalid date is a 400, also before any import', async () => {
    for (const date of [undefined, '', 'banana', '2026-02-30', '14/10/2026', '2026-10-14T10:00']) {
      const res = await todayGET(todayReq(date));
      expect(res.status, String(date)).toBe(400);
      const body = await json(res);
      expect(body.ok).toBe(false);
      expect(body.message).toContain('date');
    }
  });

  it('before any import: 409 with a clear message', async () => {
    const res = await todayGET(todayReq('2026-10-14'));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toMatchObject({ ok: false, noImport: true });
    expect(body.message).toContain('Waitlist (admin)');
  });

  it('imports the sample through the import route', async () => {
    expect((await importPOST(importRequest())).status).toBe(200);
  }, 120_000);

  it('Wed Oct 14: O34, O35, O36 in start order with the key\'s first 3 names', async () => {
    const d = await day('2026-10-14');
    expect(d.dateLabel).toBe('Wed, Oct 14');
    expect(d.count).toBe(3);
    expect(d.openings.map((o) => o.id)).toEqual(['O34', 'O35', 'O36']);
    expect(d.openings.map((o) => o.start)).toEqual(['11:00', '15:00', '16:00']);
    expect(d.openings.map((o) => ids(o))).toEqual([
      ['W33', 'W42', 'W48'],
      ['W42', 'W49', 'W53'],
      ['W10', 'W12', 'W40'],
    ]);
    // ... which are the first 3 of Tanya's list for each opening
    for (const o of d.openings) expect(ids(o)).toEqual(keyList(o.id).slice(0, 3));
    expect(d.openings.map((o) => o.fitLabel)).toEqual(['3 people fit', '3 people fit', '3 people fit']);
    expect(d.openings.map((o) => o.lengthMin)).toEqual([60, 60, 60]);
    expect(d.openings[0]).toMatchObject({
      summary: 'Rachel Thibodeau · Wed, Oct 14 · 11:00 AM to 12:00 PM · 60 min',
      short: false,
      nobody: null,
      filled: null,
      joseeNote: false,
    });
    expect(d.openings[0]!.cards[0]).toEqual({ n: 1, lineId: 'W33', name: 'Patrick Chiasson', phone: '(506) 555-0131', tel: 'tel:+15065550131' });
    expect(d.context).toMatchObject({ runDate: '2026-10-21', peopleReady: 30, bookingExportDate: '2026-10-17' });
    expect(d.dates).toEqual({ first: '2026-09-21', last: '2026-10-17' });
  });

  it('every date of the file: start-time order, and the same names as the file search', async () => {
    const all = parseOpenings(read(NAMES.openings));
    const file = ((await json(await fileSearchPOST(new Request('http://localhost/api/search/file', { method: 'POST', body: new FormData() })))).openings as OpeningView[]);
    const byId = new Map(file.map((o) => [o.id, o]));
    let total = 0;
    for (const date of [...new Set(all.map((o) => o.date))]) {
      const d = await day(date);
      const expected = all.filter((o) => o.date === date).sort((a, b) => a.start.localeCompare(b.start));
      expect(d.openings.map((o) => o.id), date).toEqual(expected.map((o) => o.opening_id));
      expect(d.count).toBe(expected.length);
      for (const o of d.openings) {
        expect(names(o), o.id).toEqual(names(byId.get(o.id)!));
        expect(o.nobody, o.id).toEqual(byId.get(o.id)!.nobody);
      }
      total += d.count;
    }
    expect(total).toBe(44);
  }, 60_000);

  it('a Josée opening carries her note flag, a no-show says why nobody', async () => {
    const d = await day('2026-09-21');
    const o01 = d.openings.find((o) => o.id === 'O01')!;
    expect(o01.joseeNote).toBe(true);
    const o02 = d.openings.find((o) => o.id === 'O02')!;
    expect(o02.kind).toBe('no-show');
    expect(o02.nobody?.head).toBe('No-show: there is no time to offer it.');
  });

  it('a date with no openings: empty list, count 0, and the first and last dates of the file', async () => {
    const d = await day('2026-10-18');
    expect(d).toMatchObject({ ok: true, date: '2026-10-18', dateLabel: 'Sun, Oct 18', count: 0, openings: [] });
    expect(d.dates).toEqual({ first: '2026-09-21', last: '2026-10-17' });
    const today = await day('2026-10-29');
    expect(today.count).toBe(0);
  });

  it('Booked on Oct 14: Amanda (W42) for O34 fills O34 and leaves O35 and every other opening', async () => {
    const before = await day('2026-10-14');
    expect(ids(before.openings[1]!)).toContain('W42');

    const res = await bookedPOST(bookReq('O34', 'W42'));
    expect(res.status).toBe(200);
    expect((await json(res)).record).toMatchObject({ openingId: 'O34', lineId: 'W42', personName: 'Amanda Bourgeois' });

    const d = await day('2026-10-14');
    const [o34, o35, o36] = d.openings;
    expect(o34!.filled).toMatchObject({ lineId: 'W42', name: 'Amanda Bourgeois' });
    expect(o34!.cards).toEqual([]);
    expect(o34!.fitLabel).toBe('Filled');
    // O35 had W42, W49, W53 on Tanya's list: without Amanda that is W49 and W53, still in list order.
    expect(names(o35!)).toEqual(['W49 Andrea Pitre', 'W53 Luc Bernard']);
    expect(ids(o35!)).toEqual(keyList('O35').filter((l) => l !== 'W42'));
    expect(o35!.fitLabel).toBe('2 people fit');
    expect(o35!.short).toBe(true);
    expect(o35!.cards.map((c) => c.n)).toEqual([1, 2]);
    // Nobody else on the page is Amanda, and O36 is unchanged.
    for (const o of d.openings) expect(ids(o)).not.toContain('W42');
    expect(ids(o36!)).toEqual(['W10', 'W12', 'W40']);
    // Other days: she is not offered anywhere either.
    for (const date of ['2026-09-21', '2026-10-01', '2026-10-17']) {
      for (const o of (await day(date)).openings) expect(ids(o), o.id).not.toContain('W42');
    }
  });

  it('a second Booked on the same opening is refused and the page does not change', async () => {
    const res = await bookedPOST(bookReq('O34', 'W48'));
    expect(res.status).toBe(409);
    expect((await json(res)).message).toBe('Already filled by Amanda Bourgeois (line W42).');
    const d = await day('2026-10-14');
    expect(d.openings[0]!.filled?.name).toBe('Amanda Bourgeois');
  });

  it('a person booked for O35 leaves O34 and O36 too (same person, two slots)', async () => {
    // Undo O34 first so Amanda is free again, then book Andrea (W49) for O35.
    expect((await bookedDELETE(undoReq('O34'))).status).toBe(200);
    const back = await day('2026-10-14');
    expect(ids(back.openings[0]!)).toEqual(['W33', 'W42', 'W48']);
    expect(ids(back.openings[1]!)).toEqual(['W42', 'W49', 'W53']);

    expect((await bookedPOST(bookReq('O35', 'W49'))).status).toBe(200);
    const d = await day('2026-10-14');
    expect(d.openings[1]!.filled?.name).toBe('Andrea Pitre');
    expect(ids(d.openings[0]!)).toEqual(['W33', 'W42', 'W48']);
    expect(ids(d.openings[2]!)).toEqual(['W10', 'W12', 'W40']); // Andrea was 4th on O36's list; the first 3 stay
    expect(ids(d.openings[2]!)).not.toContain('W49');
    expect((await bookedDELETE(undoReq('O35'))).status).toBe(200);
  });

  it('Undo brings Amanda back and the context version moves with every change', async () => {
    const v0 = (await day('2026-10-14')).context.version;
    expect((await bookedPOST(bookReq('O34', 'W42'))).status).toBe(200);
    const v1 = (await day('2026-10-14')).context.version;
    expect((await bookedDELETE(undoReq('O34'))).status).toBe(200);
    const d = await day('2026-10-14');
    expect(v1).toBeGreaterThan(v0);
    expect(d.context.version).toBeGreaterThan(v1);
    expect(d.openings.map((o) => ids(o))).toEqual([
      ['W33', 'W42', 'W48'],
      ['W42', 'W49', 'W53'],
      ['W10', 'W12', 'W40'],
    ]);
  });

  it('no health words in any response', () => {
    expect(bodies.length).toBeGreaterThan(10);
    const all = bodies.join('\n').toLowerCase();
    for (const word of HEALTH_WORDS) expect(all, word).not.toContain(word);
  });
});
