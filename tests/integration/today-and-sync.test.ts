// Integration: Features 1-6c through Screen 3 "Today's openings" and live sync. GET /api/today, GET /api/state,
// POST /api/search/file, POST and DELETE /api/booked and POST /api/import are called directly with Request objects,
// together with the CLI library (runShortlist + resultsCsv) and the live-sync watcher (createVersionWatcher) wired
// to the real GET /api/state handler and an in-memory channel shared by two "tabs". No dev server is used or started.
// Expected behaviour: ../build-plan.md section 4 "Keeping the backend in sync (Booked)" (save first then show;
// everything reads the same records; other open screens update by themselves within a few seconds; undo; booked
// survives a new import), section 6 Screen 3 (every late opening of the day, up to 3 names each, never the same
// person as available for two openings once they are Booked for one), section 7 (done checks); ../rules.md "Always".
// Every test gets its own empty SHORTLIST_DATA_DIR with SHORTLIST_NO_CLAUDE=1 and imports the sample through the
// import route. data/sample/ is only read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST as importPOST } from '@/app/api/import/route';
import { GET as stateGET } from '@/app/api/state/route';
import { POST as fileSearchPOST } from '@/app/api/search/file/route';
import { DELETE as bookedDELETE, POST as bookedPOST } from '@/app/api/booked/route';
import { GET as todayGET } from '@/app/api/today/route';
import { openRunCache } from '@/lib/cache-setup';
import { parseOpenings, parseWaitlist } from '@/lib/csv';
import { createVersionWatcher, DEFAULT_INTERVAL_MS } from '@/lib/live/version-watcher';
import type { Version, VersionWatcher, WatcherChannel } from '@/lib/live/version-watcher';
import { resultsCsv, runShortlist } from '@/lib/run';
import { parseAnswerKey, parseResultsCsv } from '@/lib/score';
import { shortDate } from '@/lib/search-view';
import type { OpeningView } from '@/lib/search-view';
import type { TodayResult } from '@/lib/server/today-service';
import type { TodayOpeningView } from '@/lib/today-view';
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
const OCT14 = '2026-10-14';

const SAMPLE_OPENINGS: Opening[] = parseOpenings(sampleText(NAMES.openings));
/** Every date in the late openings file, in date order. */
const DATES = [...new Set(SAMPLE_OPENINGS.map((o) => o.date))].sort();
const FIRST_DATE = DATES[0]!;
const LAST_DATE = DATES[DATES.length - 1]!;
/** Tanya's answer key: opening id -> every line id that fits, in list order. */
const KEY = parseAnswerKey(sampleText('answer-key-tanya.csv')).openings;
const AMANDA = { name: 'Amanda Bourgeois', lines: ['W26', 'W42'], newest: 'W42' };

/** That day's openings from the file, in start order (stable for two openings at the same time). */
const fileDay = (date: string) =>
  SAMPLE_OPENINGS.map((o, i) => ({ o, i }))
    .filter(({ o }) => o.date === date)
    .sort((a, b) => a.o.start.localeCompare(b.o.start) || a.i - b.i)
    .map(({ o }) => o);

// ---- nothing outside the temp dirs is touched ------------------------------------------------------------

const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(path.join(SAMPLE, f)));

let TMP = '';
let n = 0;
let cliCsv = '';
const env = { data: process.env.SHORTLIST_DATA_DIR, noClaude: process.env.SHORTLIST_NO_CLAUDE };

beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-today-sync-'));
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

/** A fresh, empty store (build-plan section 4: test runs use their own empty store). */
function freshStore() {
  process.env.SHORTLIST_DATA_DIR = path.join(TMP, `store-${++n}`);
  process.env.SHORTLIST_NO_CLAUDE = '1';
}

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

// ---- calling the routes (every today and state body is kept for the privacy scan) --------------------------

type Label = 'today' | 'state';
const seen: { label: Label; text: string; body: any }[] = [];

async function keep(label: Label, res: Response): Promise<{ status: number; body: any }> {
  const text = await res.text();
  const body = JSON.parse(text);
  seen.push({ label, text, body });
  return { status: res.status, body };
}

type Day = Extract<TodayResult, { ok: true }>;

async function importFiles(): Promise<any> {
  const form = new FormData();
  for (const kind of ['waitlist', 'openings', 'appointments'] as const) {
    form.append(kind, new File([sampleText(NAMES[kind])], NAMES[kind], { type: 'text/csv' }));
  }
  form.append('runDate', RUN_DATE);
  const res = await importPOST(new Request('http://localhost/api/import', { method: 'POST', body: form }));
  const body = await res.json();
  expect(res.status, body.message).toBe(200);
  return body;
}

async function todayRaw(date?: string): Promise<{ status: number; body: any }> {
  const q = date === undefined ? '' : `?date=${encodeURIComponent(date)}`;
  return keep('today', await todayGET(new Request(`http://localhost/api/today${q}`)));
}

async function today(date: string): Promise<Day> {
  const { status, body } = await todayRaw(date);
  expect(status, `${date}: ${body.message}`).toBe(200);
  return body as Day;
}

async function state(): Promise<{ version: number; import: unknown }> {
  const { status, body } = await keep('state', await stateGET());
  expect(status).toBe(200);
  return body;
}
const version = async () => (await state()).version;

async function searchFile(): Promise<any> {
  const res = await fileSearchPOST(new Request('http://localhost/api/search/file', { method: 'POST', body: new FormData() }));
  const body = await res.json();
  expect(res.status, body.message).toBe(200);
  return body;
}

async function book(openingId: string, lineId: string): Promise<BookedRecord> {
  const res = await bookedPOST(
    new Request('http://localhost/api/booked', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ openingId, lineId }),
    }),
  );
  const body = await res.json();
  expect(res.status, `${openingId} ${lineId}: ${body.message}`).toBe(200);
  return body.record;
}

async function undo(openingId: string): Promise<void> {
  const res = await bookedDELETE(
    new Request(`http://localhost/api/booked?openingId=${encodeURIComponent(openingId)}`, { method: 'DELETE' }),
  );
  const body = await res.json();
  expect(res.status, `${openingId}: ${body.message}`).toBe(200);
}

const ids = (o: OpeningView) => o.cards.map((c) => c.lineId);
const byId = <T extends OpeningView>(views: T[]) => new Map(views.map((v) => [v.id, v]));
/** A Today card without its length is exactly the Search screen's view of the same opening. */
const asSearchView = ({ lengthMin: _len, ...rest }: TodayOpeningView): OpeningView => rest;
/** The person (any of their line ids, or their name) on any card. */
const shownIn = (views: OpeningView[], who: { lineIds: string[]; name: string }) =>
  views.filter((v) => v.cards.some((c) => who.lineIds.includes(c.lineId) || c.name === who.name)).map((v) => v.id);
const amanda = { lineIds: AMANDA.lines, name: AMANDA.name };

// =============================================================================================================

describe('1. Today = search = CLI, every day', () => {
  it(
    'every date of the late openings file: GET /api/today has that day in start order with the file search\'s and resultsCsv\'s line ids; all 44 openings exactly once',
    async () => {
      freshStore();
      await importFiles();
      const file = await searchFile();
      expect(file.resultsCsv).toBe(cliCsv);
      const cli = parseResultsCsv(cliCsv);
      const fileViews = byId<OpeningView>(file.openings);
      expect(SAMPLE_OPENINGS).toHaveLength(44);
      expect(cli.size).toBe(44);

      const covered: string[] = [];
      let withNames = 0;
      for (const date of DATES) {
        const d = await today(date);
        const expected = fileDay(date);
        expect(d.date).toBe(date);
        expect(d.dateLabel, date).toBe(shortDate(date));
        expect(d.count, date).toBe(expected.length);
        expect(d.openings.map((o) => o.id), date).toEqual(expected.map((o) => o.opening_id));
        const starts = d.openings.map((o) => o.start);
        expect(starts, `${date} start order`).toEqual([...starts].sort());
        expect(d.dates).toEqual({ first: FIRST_DATE, last: LAST_DATE });
        for (const o of d.openings) {
          const src = expected.find((e) => e.opening_id === o.id)!;
          expect(o.date, o.id).toBe(date);
          expect(o.lengthMin, o.id).toBe(src.length_min);
          expect(o.filled, o.id).toBeNull();
          expect(ids(o), `${o.id} vs file search`).toEqual(ids(fileViews.get(o.id)!));
          expect(ids(o), `${o.id} vs CLI resultsCsv`).toEqual(cli.get(o.id));
          expect(asSearchView(o), o.id).toEqual(fileViews.get(o.id));
          expect(o.cards.length, o.id).toBeLessThanOrEqual(3);
          if (o.cards.length > 0) withNames++;
          covered.push(o.id);
        }
      }
      // Together the days cover the file exactly once.
      expect(covered).toHaveLength(44);
      expect(new Set(covered).size).toBe(44);
      expect([...covered].sort()).toEqual(SAMPLE_OPENINGS.map((o) => o.opening_id).sort());
      // The comparison bites: most openings have names.
      expect(withNames).toBeGreaterThan(25);
    },
    TIMEOUT,
  );
});

describe('2. a busy day', () => {
  it(
    'the date with the most openings: book the first suggested person of the first opening -> filled there, gone from every other opening on every date; the rest still on Tanya\'s list',
    async () => {
      freshStore();
      await importFiles();
      const counts = new Map<string, number>();
      for (const o of SAMPLE_OPENINGS) counts.set(o.date, (counts.get(o.date) ?? 0) + 1);
      // Most openings; on a tie, the earliest date.
      const [busy, most] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
      expect(most).toBeGreaterThanOrEqual(4);

      const before = await today(busy);
      expect(before.count).toBe(most);
      const first = before.openings[0]!;
      expect(first.cards.length, `${first.id} has someone to call`).toBeGreaterThan(0);
      const person = first.cards[0]!;
      const who = { lineIds: [person.lineId], name: person.name };
      // The test bites: before the booking that person is offered on other openings of the file.
      const allBefore = new Map<string, Day>();
      for (const date of DATES) allBefore.set(date, date === busy ? before : await today(date));
      const offeredBefore = [...allBefore.values()].flatMap((d) => shownIn(d.openings, who));
      expect(offeredBefore.filter((id) => id !== first.id).length, `${person.name} elsewhere`).toBeGreaterThan(0);

      const v0 = await version();
      const record = await book(first.id, person.lineId);
      expect(record).toMatchObject({ openingId: first.id, lineId: person.lineId, personName: person.name });
      expect(await version()).toBe(v0 + 1);

      const after = await today(busy);
      expect(after.context.version).toBe(v0 + 1);
      expect(after.openings.map((o) => o.id)).toEqual(before.openings.map((o) => o.id));
      const filled = after.openings[0]!;
      expect(filled.fitLabel).toBe('Filled');
      expect(filled.cards).toEqual([]);
      expect(filled.filled).toMatchObject({ lineId: person.lineId, name: person.name, at: record.at });
      // Not in any other opening of the day; everyone else shown before is still shown first, in the same order.
      expect(shownIn(after.openings, who)).toEqual([]);
      for (const [i, o] of after.openings.entries()) {
        if (i === 0) continue;
        expect(o.filled, o.id).toBeNull();
        const kept = ids(before.openings[i]!).filter((id) => id !== person.lineId);
        expect(ids(o).slice(0, kept.length), o.id).toEqual(kept);
      }
      // Friday rule: every name still shown on the day is on Tanya's list for its opening.
      for (const o of after.openings) {
        for (const id of ids(o)) expect(KEY.get(o.id), `${o.id} shows ${id}`).toContain(id);
      }
      // No other date offers that person either, and only the one opening is filled anywhere.
      let filledCount = 0;
      for (const date of DATES) {
        const d = date === busy ? after : await today(date);
        expect(shownIn(d.openings, who), date).toEqual([]);
        filledCount += d.openings.filter((o) => o.filled !== null).length;
      }
      expect(filledCount).toBe(1);
      // Today still agrees with the file search after the booking.
      const fileViews = byId<OpeningView>((await searchFile()).openings);
      for (const o of after.openings) expect(asSearchView(o), o.id).toEqual(fileViews.get(o.id));
    },
    TIMEOUT,
  );
});

// ---- two people at the desk: the watcher, the real state route, a shared fake channel --------------------

/** In-memory stand-in for BroadcastChannel: every channel opened on the bus hears every post. */
class FakeBus {
  private channels = new Set<FakeChannel>();
  open(): FakeChannel {
    const c = new FakeChannel(this.channels);
    this.channels.add(c);
    return c;
  }
  /** announceChange(): a fresh channel posts, so every open channel (the poster's own tab included) hears it. */
  post() {
    for (const c of [...this.channels]) c.deliver();
  }
}
class FakeChannel implements WatcherChannel {
  listeners = new Set<() => void>();
  constructor(private readonly all: Set<FakeChannel>) {}
  addEventListener(_type: 'message', listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: () => void) {
    this.listeners.delete(listener);
  }
  close() {
    this.all.delete(this);
  }
  deliver() {
    for (const l of [...this.listeners]) l();
  }
}

/** Every promise the tabs start (version checks, refetches), so a step can wait for them all. */
const pending = new Set<Promise<unknown>>();
function track<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  p.then(
    () => pending.delete(p),
    () => pending.delete(p),
  );
  return p;
}
const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await macrotask();
    if (pending.size === 0) {
      await macrotask();
      if (pending.size === 0) return;
    }
    await Promise.allSettled([...pending]);
  }
  throw new Error('the tabs never settled');
}
/** Advance the fake clock (only setInterval is faked) and wait for whatever that started. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

interface Tab {
  name: string;
  date: string;
  /** The day this tab is showing right now. */
  day: Day;
  /** The first day it loaded. */
  first: Day;
  /** Versions its watcher reported as changes. */
  changes: Version[];
  /** Calls to GET /api/state made by its watcher. */
  checks: number;
  hidden: boolean;
  errors: unknown[];
  setHidden(hidden: boolean): void;
  watcher: VersionWatcher;
  channel: FakeChannel;
}

/** A Today screen in one tab, wired the way use-live-version.ts wires it. */
async function openTab(name: string, date: string, bus: FakeBus): Promise<Tab> {
  const day = await today(date);
  const visibility = new Set<() => void>();
  const channel = bus.open();
  const tab = {
    name,
    date,
    day,
    first: day,
    changes: [],
    checks: 0,
    hidden: false,
    errors: [],
    channel,
    setHidden(hidden: boolean) {
      tab.hidden = hidden;
      for (const cb of [...visibility]) cb();
    },
  } as unknown as Tab;
  tab.watcher = createVersionWatcher({
    fetchVersion: () =>
      track(
        (async () => {
          tab.checks++;
          const body = await state();
          if (typeof body.version !== 'number') throw new Error('no version');
          return body.version;
        })(),
      ),
    onChange: (v) => {
      tab.changes.push(v);
      void track(
        reload(tab).catch((err) => {
          tab.errors.push(err);
        }),
      );
    },
    initialVersion: day.context.version,
    isHidden: () => tab.hidden,
    subscribeVisibility: (cb) => {
      visibility.add(cb);
      return () => visibility.delete(cb);
    },
    channel,
  });
  await settle();
  return tab;
}

/** The screen fetches its day again and tells the watcher which version it now shows (knownVersion). */
async function reload(tab: Tab): Promise<void> {
  tab.day = await today(tab.date);
  tab.watcher.acknowledge(tab.day.context.version);
}

/** Booked from a tab, as today-screen.tsx does it: save, announce on the channel, fetch the day again. */
async function bookFromTab(tab: Tab, bus: FakeBus, openingId: string, lineId: string): Promise<BookedRecord> {
  const record = await book(openingId, lineId);
  bus.post();
  await reload(tab);
  await settle();
  return record;
}
async function undoFromTab(tab: Tab, bus: FakeBus, openingId: string): Promise<void> {
  await undo(openingId);
  bus.post();
  await reload(tab);
  await settle();
}

const openingIn = (d: Day, id: string) => d.openings.find((o) => o.id === id)!;

describe('3-4. two people at the desk: sync through the version', () => {
  const bus = new FakeBus();
  let A: Tab;
  let B: Tab;

  beforeAll(async () => {
    freshStore();
    await importFiles();
    // Only the watcher's poll timer is fake; file reads, setImmediate and Date stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    A = await openTab('A', OCT14, bus);
    B = await openTab('B', OCT14, bus);
  }, TIMEOUT);

  afterAll(() => {
    A?.watcher.stop();
    B?.watcher.stop();
    A?.channel.close();
    B?.channel.close();
    vi.useRealTimers();
  });

  it(
    '3. Tab A books Amanda (W42) on O34 and posts; Tab B refetches at once. Another device books O36 (no message): Tab B catches it by polling. Hidden: no polling; visible again: checks at once',
    async () => {
      // Both tabs loaded the same day, opened without reporting a change.
      expect(A.changes).toEqual([]);
      expect(B.changes).toEqual([]);
      expect(A.checks).toBe(1);
      expect(B.checks).toBe(1);
      expect(B.day.openings.map((o) => o.id)).toEqual(['O34', 'O35', 'O36']);
      expect(shownIn(B.day.openings, amanda)).toEqual(['O34', 'O35']);
      const v0 = B.day.context.version;

      // -- Tab A: Booked, then the channel message. No time passes.
      const record = await bookFromTab(A, bus, 'O34', AMANDA.newest);
      expect(B.changes).toEqual([v0 + 1]);
      expect(B.errors).toEqual([]);
      expect(B.day.context.version).toBe(v0 + 1);
      const o34 = openingIn(B.day, 'O34');
      expect(o34.fitLabel).toBe('Filled');
      expect(o34.cards).toEqual([]);
      expect(o34.filled).toMatchObject({ lineId: AMANDA.newest, name: AMANDA.name, at: record.at });
      expect(shownIn(B.day.openings, amanda)).toEqual([]);
      // Tab A shows its own booking too.
      expect(openingIn(A.day, 'O34').filled).toMatchObject({ lineId: AMANDA.newest });
      expect(shownIn(A.day.openings, amanda)).toEqual([]);

      // -- Another device books O36 straight through the route: no channel message.
      const o36Before = openingIn(B.day, 'O36');
      expect(o36Before.cards.length).toBeGreaterThan(0);
      const o36Person = o36Before.cards[0]!;
      const bChanges = B.changes.length;
      const bChecks = B.checks;
      const aChanges = A.changes.length;
      await book('O36', o36Person.lineId);
      await settle();
      // Nothing told the tabs yet, and no time has passed.
      expect(B.changes).toHaveLength(bChanges);
      expect(B.checks).toBe(bChecks);
      expect(openingIn(B.day, 'O36').filled).toBeNull();

      await tick(DEFAULT_INTERVAL_MS);
      expect(B.checks).toBe(bChecks + 1);
      expect(B.changes).toEqual([v0 + 1, v0 + 2]);
      expect(B.day.context.version).toBe(v0 + 2);
      expect(openingIn(B.day, 'O36').filled).toMatchObject({ lineId: o36Person.lineId, name: o36Person.name });
      expect(shownIn(B.day.openings, { lineIds: [o36Person.lineId], name: o36Person.name })).toEqual([]);
      // Tab A, also open, catches the other device's booking the same way.
      expect(A.changes.length).toBe(aChanges + 1);
      expect(openingIn(A.day, 'O36').filled).toMatchObject({ lineId: o36Person.lineId });

      // -- Tab B goes hidden; O36 is undone elsewhere and another tab even announces it.
      B.setHidden(true);
      await settle();
      const hiddenChecks = B.checks;
      const hiddenChanges = B.changes.length;
      const aBefore = A.changes.length;
      await undo('O36');
      bus.post();
      await settle();
      await tick(10 * DEFAULT_INTERVAL_MS);
      expect(B.checks, 'Tab B polled while hidden').toBe(hiddenChecks);
      expect(B.changes).toHaveLength(hiddenChanges);
      expect(openingIn(B.day, 'O36').filled, 'Tab B still shows what it had').not.toBeNull();
      // The visible tab heard it straight away.
      expect(A.changes.length).toBe(aBefore + 1);
      expect(openingIn(A.day, 'O36').filled).toBeNull();

      // -- Tab B becomes visible: it checks at once (no timer) and catches up.
      B.setHidden(false);
      await settle();
      expect(B.checks).toBe(hiddenChecks + 1);
      expect(B.changes).toEqual([v0 + 1, v0 + 2, v0 + 3]);
      expect(B.day.context.version).toBe(v0 + 3);
      expect(openingIn(B.day, 'O36').filled).toBeNull();
      expect(openingIn(B.day, 'O36').cards).toEqual(o36Before.cards);
      expect(B.errors).toEqual([]);
      expect(A.errors).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    '4. undo O34 from Tab B -> Tab A\'s watcher fires and Amanda is back in O34 and O35 as before',
    async () => {
      expect(openingIn(A.day, 'O34').filled).toMatchObject({ lineId: AMANDA.newest });
      const aChanges = A.changes.length;
      const v = await version();

      await undoFromTab(B, bus, 'O34');
      expect(A.changes.length).toBe(aChanges + 1);
      expect(A.changes[A.changes.length - 1]).toBe(v + 1);
      expect(A.errors).toEqual([]);
      expect(A.day.context.version).toBe(v + 1);
      expect(openingIn(A.day, 'O34').filled).toBeNull();
      expect(shownIn(A.day.openings, amanda)).toEqual(['O34', 'O35']);
      // The whole day is back to what both tabs first loaded (O36 was undone in step 3).
      expect(A.day.openings).toEqual(A.first.openings);
      expect(B.day.openings).toEqual(B.first.openings);
      expect(B.day.context.version).toBe(v + 1);
    },
    TIMEOUT,
  );
});

describe('5. Booked state survives a re-import on Today', () => {
  it(
    'book on O35, re-import the same files -> Oct 14 still shows O35 filled; the version moved once for each change',
    async () => {
      freshStore();
      const first = await importFiles();
      const v0 = await version();
      const before = await today(OCT14);
      const o35Before = openingIn(before, 'O35');
      const person = o35Before.cards[0]!;
      const who = { lineIds: [person.lineId], name: person.name };
      expect(shownIn(before.openings, who).length).toBeGreaterThan(0);

      const record = await book('O35', person.lineId);
      expect(await version()).toBe(v0 + 1);

      const second = await importFiles();
      expect(second.import.id).not.toBe(first.import.id);
      expect(await version()).toBe(v0 + 2);

      const after = await today(OCT14);
      expect(after.context.version).toBe(v0 + 2);
      expect(after.context.importId).toBe(second.import.id);
      const o35 = openingIn(after, 'O35');
      expect(o35.fitLabel).toBe('Filled');
      expect(o35.cards).toEqual([]);
      expect(o35.filled).toMatchObject({ lineId: person.lineId, name: person.name, at: record.at });
      expect(shownIn(after.openings, who)).toEqual([]);
      for (const o of after.openings) {
        if (o.id === 'O35') continue;
        expect(o.filled, o.id).toBeNull();
        for (const id of ids(o)) expect(KEY.get(o.id), `${o.id} shows ${id}`).toContain(id);
      }
    },
    TIMEOUT,
  );
});

describe('6. empty and bad dates', () => {
  it(
    'before any import 409; an invalid date 400; a date with no openings is an empty list with the file\'s first and last dates',
    async () => {
      freshStore();
      const empty = await state();
      expect(empty).toMatchObject({ version: 0, import: null });
      const none = await todayRaw(OCT14);
      expect(none.status).toBe(409);
      expect(none.body).toMatchObject({ ok: false, noImport: true });
      expect(none.body.message).toContain('Waitlist (admin)');

      await importFiles();
      for (const bad of [undefined, '', 'banana', '2026-02-30', '2026-13-01', '10/14/2026', '2026-10-14T11:00']) {
        const res = await todayRaw(bad);
        expect(res.status, String(bad)).toBe(400);
        expect(res.body.ok).toBe(false);
        expect(res.body.message).toContain('date');
      }

      // A Saturday inside the file's range, the day after it ends, and a date far away.
      for (const date of ['2026-09-26', '2026-10-18', '2027-01-04']) {
        expect(DATES, date).not.toContain(date);
        const d = await today(date);
        expect(d).toMatchObject({ ok: true, date, dateLabel: shortDate(date), count: 0, openings: [] });
        expect(d.dates).toEqual({ first: FIRST_DATE, last: LAST_DATE });
      }
      expect(FIRST_DATE).toBe('2026-09-21');
      expect(LAST_DATE).toBe('2026-10-17');
    },
    TIMEOUT,
  );
});

// ---- privacy (runs last: scans every today and state body this file saw) ---------------------------------

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

describe('7. privacy', () => {
  it('every /api/today and /api/state body in this file: no health words, no note text', () => {
    const notes = parseWaitlist(sampleText(NAMES.waitlist), RUN_YEAR)
      .map((l) => l.notes.trim())
      .filter((t) => t !== '');
    expect(notes.length).toBeGreaterThan(50);
    // The scan bites: the waitlist itself has health words.
    expect(healthHits(sampleText(NAMES.waitlist)).length).toBeGreaterThan(3);

    expect([...new Set(seen.map((s) => s.label))].sort()).toEqual(['state', 'today']);
    expect(seen.filter((s) => s.label === 'today').length).toBeGreaterThan(50);
    expect(seen.filter((s) => s.label === 'state').length).toBeGreaterThan(10);

    let cards = 0;
    for (const { label, text, body } of seen) {
      expect(healthHits(text), `${label}: health words`).toEqual([]);
      const strings = stringsIn(body);
      for (const note of notes) {
        expect(strings.find((s) => s.includes(note)), `${label}: contains the note "${note}"`).toBeUndefined();
      }
      expect(text).not.toContain('"notes"');
      if (label !== 'today' || !Array.isArray(body.openings)) continue;
      for (const o of body.openings as TodayOpeningView[]) {
        for (const c of o.cards) {
          cards++;
          expect(Object.keys(c).sort(), o.id).toEqual(['lineId', 'n', 'name', 'phone', 'tel']);
        }
      }
    }
    expect(cards).toBeGreaterThan(100);
  });
});
