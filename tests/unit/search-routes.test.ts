// The Search screen's routes (feature 6b): POST /api/search, POST /api/search/file, POST and DELETE /api/booked.
// Called directly with Request objects on a temp store with no Claude; the sample is imported through the
// import route first. Expected behaviour: ../build-plan.md section 4 (Booked: save first, one per opening, undo)
// and section 6 Screens 1-2; ../rules.md Step 4 and "Always".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as importPOST } from '@/app/api/import/route';
import { POST as searchPOST } from '@/app/api/search/route';
import { POST as fileSearchPOST } from '@/app/api/search/file/route';
import { DELETE as bookedDELETE, POST as bookedPOST } from '@/app/api/booked/route';
import { openRunCache } from '@/lib/cache-setup';
import { parseOpenings } from '@/lib/csv';
import { resultsCsv, runShortlist } from '@/lib/run';
import type { OpeningView } from '@/lib/search-view';

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

function importRequest(runDate = '2026-10-21') {
  const form = new FormData();
  for (const kind of ['waitlist', 'openings', 'appointments'] as const) form.append(kind, csvFile(read(NAMES[kind]), NAMES[kind]));
  form.append('runDate', runDate);
  return new Request('http://localhost/api/import', { method: 'POST', body: form });
}

const searchReq = (body: unknown) =>
  new Request('http://localhost/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function fileReq(file?: File) {
  const form = new FormData();
  if (file) form.append('openings', file);
  return new Request('http://localhost/api/search/file', { method: 'POST', body: form });
}

const bookReq = (openingId: string, lineId: string) =>
  new Request('http://localhost/api/booked', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ openingId, lineId }),
  });
const undoReq = (openingId: string) =>
  new Request(`http://localhost/api/booked?openingId=${encodeURIComponent(openingId)}`, { method: 'DELETE' });

const names = (o: OpeningView) => o.cards.map((c) => `${c.lineId} ${c.name}`);

let dir: string;
let cliCsv: string;
const env = { data: process.env.SHORTLIST_DATA_DIR, noClaude: process.env.SHORTLIST_NO_CLAUDE };
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlist-search-'));
  process.env.SHORTLIST_DATA_DIR = path.join(dir, 'store');
  process.env.SHORTLIST_NO_CLAUDE = '1';
  // The CLI library on the same files, with its own cache and no Booked marks.
  const run = await runShortlist({
    waitlistText: read(NAMES.waitlist),
    openingsText: read(NAMES.openings),
    appointmentsText: read(NAMES.appointments),
    runDate: '2026-10-21',
    cache: openRunCache(path.join(dir, 'cli-cache.json')),
    client: null,
  });
  cliCsv = resultsCsv(run.results);
}, 120_000);
afterAll(() => {
  if (env.data === undefined) delete process.env.SHORTLIST_DATA_DIR;
  else process.env.SHORTLIST_DATA_DIR = env.data;
  if (env.noClaude === undefined) delete process.env.SHORTLIST_NO_CLAUDE;
  else process.env.SHORTLIST_NO_CLAUDE = env.noClaude;
  fs.rmSync(dir, { recursive: true, force: true });
});

const O39 = { date: '2026-10-15', start: '14:00', therapist: 'Dave Melanson', length: 60, cancelledAt: '2026-10-15T10:40' };

// The tests in this file run in order on one store.
describe('search routes', () => {
  it('before any import: every route answers 409 with a clear message', async () => {
    for (const res of [await searchPOST(searchReq(O39)), await fileSearchPOST(fileReq()), await bookedPOST(bookReq('O34', 'W42'))]) {
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.ok).toBe(false);
      expect(body.noImport).toBe(true);
      expect(body.message).toContain('Waitlist (admin)');
    }
  });

  it('imports the sample through the import route', async () => {
    const res = await importPOST(importRequest());
    expect(res.status).toBe(200);
  }, 120_000);

  it('one opening: Thu Oct 15 2:00 PM, Dave, 60 min, cancelled 10:40 gives the same 3 as O39 in the CLI', async () => {
    const res = await searchPOST(searchReq(O39));
    expect(res.status).toBe(200);
    const body = await json(res);
    const o: OpeningView = body.opening;
    expect(names(o)).toEqual(['W46 Shawn Duguay', 'W53 Luc Bernard', 'W57 Lise Gautreau']);
    expect(o.cards.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(o.fitLabel).toBe('3 people fit');
    expect(o.summary).toBe('Dave Melanson · Thu, Oct 15 · 2:00 to 3:00 PM · 60 min');
    expect(o.short).toBe(false);
    expect(o.nobody).toBeNull();
    expect(o.filled).toBeNull();
    expect(o.cards[0]).toMatchObject({ phone: '(506) 555-0140', tel: 'tel:+15065550140' });
    // The same slot as O39 in the imported file keeps that id, so it can only be booked once.
    expect(o.id).toBe('O39');
    expect(cliCsv).toContain('O39,W46 Shawn Duguay (506-555-0140); W53 Luc Bernard (506-555-0121); W57 Lise Gautreau');
    expect(body.context).toMatchObject({ runDate: '2026-10-21', peopleReady: 30, bookingExportDate: '2026-10-17' });
  });

  it('one opening that is not in the file gets a Q- id from its slot', async () => {
    const res = await searchPOST(searchReq({ ...O39, start: '14:30', cancelledAt: '2026-10-15 10:40' }));
    expect(res.status).toBe(200);
    expect((await json(res)).opening.id).toBe('Q-20261015-1430-DM');
  });

  it('one opening: Thu Oct 15 4:00 PM, Rachel, 60 min, cancelled 2:43 PM gives nobody with 1 h 17 min', async () => {
    const res = await searchPOST(
      searchReq({ date: '2026-10-15', start: '16:00', therapist: 'Rachel Thibodeau', length: 60, cancelledAt: '2026-10-15T14:43' }),
    );
    expect(res.status).toBe(200);
    const o: OpeningView = (await json(res)).opening;
    expect(o.cards).toEqual([]);
    expect(o.fitLabel).toBe('Nobody fits');
    expect(o.summary).toBe('Rachel Thibodeau · Thu, Oct 15 · 4:00 to 5:00 PM · 60 min');
    expect(o.nobody).toEqual({
      head: 'No one on the waitlist can take this opening.',
      why: 'Nobody matches this therapist, day, time, length and notice (1 h 17 min).',
    });
  });

  it('one opening: every opening of the sample file gives the same names as the file search', async () => {
    const file: OpeningView[] = (await json(await fileSearchPOST(fileReq()))).openings;
    const byId = new Map(file.map((o) => [o.id, o]));
    for (const o of parseOpenings(read(NAMES.openings)).filter((x) => x.kind === 'late cancel')) {
      const res = await searchPOST(
        searchReq({ date: o.date, start: o.start, therapist: o.therapist, length: o.length_min, cancelledAt: o.cancelled_at }),
      );
      const one: OpeningView = (await json(res)).opening;
      expect(one.id).toBe(o.opening_id);
      expect(names(one), o.opening_id).toEqual(names(byId.get(o.opening_id)!));
    }
  }, 60_000);

  it('one opening: invalid input is a 400 that says what to fix', async () => {
    const cases: [unknown, string][] = [
      [{ ...O39, therapist: 'Nobody Here' }, 'therapist'],
      [{ ...O39, length: 75 }, 'length'],
      [{ ...O39, date: '2026-02-30' }, 'date'],
      [{ ...O39, start: '25:00' }, 'start time'],
      [{ ...O39, cancelledAt: '' }, 'cancelled'],
      [{ ...O39, cancelledAt: '2026-10-15T15:00' }, 'after the start'],
      ['not json', 'JSON'],
    ];
    for (const [body, word] of cases) {
      const res = await searchPOST(searchReq(body));
      expect(res.status).toBe(400);
      const b = await json(res);
      expect(b.ok).toBe(false);
      expect(b.message).toContain(word);
    }
  });

  it('file search with no file uses the imported file: 44 / 34 / 10 and the same results.csv as the CLI', async () => {
    const res = await fileSearchPOST(fileReq());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.source).toBe('imported');
    expect(body.fileName).toBe(NAMES.openings);
    expect(body.check).toBe('44 openings · columns OK');
    expect(body.counts).toEqual({ searched: 44, withPeople: 34, nobody: 10, filled: 0 });
    expect(body.resultsCsv).toBe(cliCsv);
    const dates = (body.openings as OpeningView[]).map((o) => `${o.date} ${o.start}`);
    expect(dates).toEqual([...dates].sort());
    const o37 = (body.openings as OpeningView[]).find((o) => o.id === 'O37')!;
    expect(o37.nobody).toEqual({
      head: 'No-show: there is no time to offer it.',
      why: 'We only know 15 minutes after the start, so the waitlist isn’t searched.',
    });
    const o31 = (body.openings as OpeningView[]).find((o) => o.id === 'O31')!;
    expect(o31.nobody!.why).toBe('Nobody matches this therapist, day, time, length and notice (1 h 14 min).');
    const o32 = (body.openings as OpeningView[]).find((o) => o.id === 'O32')!;
    expect(o32.short).toBe(true);
    expect(o32.fitLabel).toBe('2 people fit');
  });

  it('file search with an uploaded file: same answer as the imported one', async () => {
    const res = await fileSearchPOST(fileReq(csvFile(read(NAMES.openings), 'friday.csv')));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.source).toBe('uploaded');
    expect(body.fileName).toBe('friday.csv');
    expect(body.resultsCsv).toBe(cliCsv);
  });

  it('file search with a bad openings file: 400 naming the missing column', async () => {
    const bad = read(NAMES.openings).replace('hours_notice', 'notice_hours');
    const res = await fileSearchPOST(fileReq(csvFile(bad, 'bad-openings.csv')));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.problems).toEqual([{ kind: 'openings', missing: ['hours_notice'] }]);
    expect(body.message).toContain('hours_notice');
    expect(body.message).toContain('bad-openings.csv');
    expect(body.check).toBe('Missing column(s): hours_notice');
  });

  let original: OpeningView[] = [];
  it('Booked Amanda (W42) on O34: 200, then O34 is filled and Amanda is in no other opening', async () => {
    original = (await json(await fileSearchPOST(fileReq()))).openings;
    const before = original.filter((o) => o.cards.some((c) => c.lineId === 'W42')).map((o) => o.id);
    expect(before).toContain('O34');
    expect(before.length).toBeGreaterThan(1);

    const res = await bookedPOST(bookReq('O34', 'W42'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.record).toMatchObject({ openingId: 'O34', lineId: 'W42', personName: 'Amanda Bourgeois', by: 'local' });
    expect(typeof body.version).toBe('number');
    expect(Number.isNaN(Date.parse(body.record.at))).toBe(false);

    const after = await json(await fileSearchPOST(fileReq()));
    const views: OpeningView[] = after.openings;
    const o34 = views.find((o) => o.id === 'O34')!;
    expect(o34.fitLabel).toBe('Filled');
    expect(o34.cards).toEqual([]);
    expect(o34.filled).toMatchObject({ lineId: 'W42', name: 'Amanda Bourgeois' });
    expect(views.filter((o) => o.cards.some((c) => c.lineId === 'W42'))).toEqual([]);
    expect(after.counts.filled).toBe(1);
    expect(after.resultsCsv).not.toContain('W42');
  });

  it('Booked again on O34 (any line): 409 with the booking already there; nothing saved', async () => {
    for (const line of ['W42', 'W33']) {
      const res = await bookedPOST(bookReq('O34', line));
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body.ok).toBe(false);
      expect(body.existing).toMatchObject({ openingId: 'O34', lineId: 'W42' });
      expect(body.message).toBe('Already filled by Amanda Bourgeois (line W42).');
    }
  });

  it('booking a line that is not a current person: 404 (booked, stale, unknown)', async () => {
    for (const line of ['W42', 'W01', 'W99']) {
      const res = await bookedPOST(bookReq('O35', line));
      expect(res.status, line).toBe(404);
      expect((await json(res)).ok).toBe(false);
    }
    const bad = await bookedPOST(bookReq('', 'W42'));
    expect(bad.status).toBe(400);
  });

  it('undo: 200, then the results are back to the original; a second undo is 404', async () => {
    const res = await bookedDELETE(undoReq('O34'));
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
    const back = await json(await fileSearchPOST(fileReq()));
    expect(back.openings).toEqual(original);
    expect(back.resultsCsv).toBe(cliCsv);
    expect((await bookedDELETE(undoReq('O34'))).status).toBe(404);
  });

  it('a one-opening booking shows the slot as filled on the next search', async () => {
    const slot = { ...O39, start: '14:30' };
    const first: OpeningView = (await json(await searchPOST(searchReq(slot)))).opening;
    expect(first.cards.length).toBeGreaterThan(0);
    const res = await bookedPOST(bookReq(first.id, first.cards[0]!.lineId));
    expect(res.status).toBe(200);
    const again: OpeningView = (await json(await searchPOST(searchReq(slot)))).opening;
    expect(again.filled).toMatchObject({ lineId: first.cards[0]!.lineId });
    expect((await bookedDELETE(undoReq(first.id))).status).toBe(200);
  });

  it('no health words in any response', () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const text of bodies) {
      const lower = text.toLowerCase();
      for (const word of HEALTH_WORDS) expect(lower.includes(word), word).toBe(false);
    }
  });
});
