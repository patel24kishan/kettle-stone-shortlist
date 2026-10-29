// One contract for every Store (feature 6e): the local file store and the Supabase store must behave the same.
// LocalStore runs on a temp folder; SupabaseStore runs on an in-memory fake of supabase/schema.sql that enforces
// the same unique constraints and version triggers (tests/fakes/fake-supabase.ts). No live Supabase project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReadingCacheEntry } from '@/lib/readings/cache';
import { LocalStore } from '@/lib/storage/local';
import { SupabaseStore } from '@/lib/storage/supabase';
import type { Store, StoredImport } from '@/lib/storage/types';
import type { BookedRecord } from '@/lib/types';
import { FakeSupabase } from '../fakes/fake-supabase';

type TestStore = Store & { listImportIds(): Promise<string[]> };

interface Harness {
  store: TestStore;
  /** A new store on the same saved data, as after a server restart. */
  reopen(): TestStore;
  /** Undone bookings as saved: { record, undoneAt }. */
  history(): Promise<Array<{ record: BookedRecord; undoneAt: string }>>;
}

let tmp: string;
let seedFile: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlist-contract-'));
  seedFile = path.join(tmp, 'seed-readings.json');
  fs.writeFileSync(seedFile, JSON.stringify({ 'seed-key': entry('saved') }), 'utf8');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const HARNESSES: Record<string, () => Harness> = {
  LocalStore: () => {
    const dir = path.join(tmp, 'store');
    const make = () => new LocalStore(dir, { seedReadingsFrom: seedFile });
    return {
      store: make(),
      reopen: make,
      history: async () => {
        const file = path.join(dir, 'booked-history.json');
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      },
    };
  },
  'SupabaseStore (in-memory fake)': () => {
    const db = new FakeSupabase();
    const make = () => new SupabaseStore(db, { seedReadingsFrom: seedFile });
    return {
      store: make(),
      reopen: make,
      history: async () =>
        db.tables.booked_history.map((r) => ({ record: r.record as BookedRecord, undoneAt: String(r.undone_at) })),
    };
  },
};

function entry(by: 'claude' | 'saved', problems: string[] = []): ReadingCacheEntry {
  return {
    reading: { therapists: ['any'], unclear: [] } as unknown as ReadingCacheEntry['reading'],
    readAt: '2026-10-21T10:00:00.000Z',
    by,
    problems,
  };
}

const summary = {
  run: { openings: 1, withPeople: 1, nobody: 0, noShows: 0, linesRead: 1, peopleActive: 1, stale: 0, duplicates: 0, notRead: [], failed: [] },
  bookingExportDate: '2026-10-17',
  rows: { waitlist: 1, openings: 1, appointments: 1 },
};
const file = (name: string, text: string) => ({ name, sha256: `sha-${name}`, text });
const makeImport = (id: string, createdAt: string, runDate = '2026-10-21'): StoredImport => ({
  id,
  runDate,
  createdAt,
  files: { waitlist: file('w.csv', 'line,added\nW1,2026-10-01'), openings: file('o.csv', 'opening_id'), appointments: file('a.csv', 'appointment_id') },
  summary,
});

const booked = (openingId: string, person: string, over: Partial<BookedRecord> = {}): BookedRecord => ({
  personPhoneDigits: `506555${person.padStart(4, '0')}`,
  personName: `Person ${person}`,
  lineId: `W${person}`,
  openingId,
  at: '2026-10-21T14:00:00.000Z',
  by: 'local',
  ...over,
});

for (const [name, makeHarness] of Object.entries(HARNESSES)) {
  describe(`Store contract: ${name}`, () => {
    let h: Harness;
    beforeEach(() => {
      h = makeHarness();
    });

    it('starts empty at version 0', async () => {
      expect(await h.store.latestImport()).toBeNull();
      expect(await h.store.listBooked()).toEqual([]);
      expect(await h.store.version()).toBe(0);
    });

    it('saves an import and gives it back exactly as the latest', async () => {
      const imp = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
      await h.store.saveImport(imp);
      expect(await h.store.latestImport()).toEqual(imp);
      expect(await h.reopen().latestImport()).toEqual(imp);
      expect(await h.store.version()).toBe(1);
    });

    it('keeps every import; the last one saved is the latest', async () => {
      const a = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
      const b = makeImport('20261022T100000000Z-bbbb', '2026-10-22T10:00:00.000Z', '2026-10-22');
      await h.store.saveImport(a);
      await h.store.saveImport(b);
      expect((await h.store.latestImport())?.id).toBe(b.id);
      expect((await h.reopen().latestImport())?.runDate).toBe('2026-10-22');
      expect(await h.store.listImportIds()).toEqual([a.id, b.id]);
      expect(await h.store.version()).toBe(2);
    });

    it('never replaces a saved import, refuses unsafe ids, and a refusal does not bump the version', async () => {
      const a = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
      await h.store.saveImport(a);
      await expect(h.store.saveImport({ ...a, runDate: '2026-10-30' })).rejects.toThrow(/never replaced/);
      await expect(h.store.saveImport({ ...a, id: '../evil' })).rejects.toThrow(/letters, digits/);
      expect((await h.reopen().latestImport())?.runDate).toBe('2026-10-21');
      expect(await h.store.version()).toBe(1);
    });

    it('one booking per opening: a second record is refused with the first, and nothing is saved', async () => {
      const first = booked('O34', '1');
      expect(await h.store.addBooked(first)).toEqual({ ok: true });
      const second = await h.store.addBooked(booked('O34', '2'));
      expect(second).toEqual({ ok: false, existing: first });
      expect(await h.store.listBooked()).toEqual([first]);
      expect(await h.store.version()).toBe(1);
    });

    it('one booking per opening holds when five taps race', async () => {
      const results = await Promise.all(['1', '2', '3', '4', '5'].map((p) => h.store.addBooked(booked('O12', p))));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const saved = await h.store.listBooked();
      expect(saved).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.existing).toEqual(saved[0]);
      expect(await h.store.version()).toBe(1);
    });

    it('one live booking per person: the same line id + phone cannot fill a second opening', async () => {
      const first = booked('O1', '7');
      await h.store.addBooked(first);
      const again = await h.store.addBooked(booked('O2', '7'));
      expect(again).toEqual({ ok: false, existing: first });
      expect((await h.store.listBooked()).map((b) => b.openingId)).toEqual(['O1']);
      expect(await h.store.version()).toBe(1);
    });

    it('one live booking per person holds when the same person is booked on five openings at once', async () => {
      const results = await Promise.all(['O1', 'O2', 'O3', 'O4', 'O5'].map((o) => h.store.addBooked(booked(o, '7'))));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const saved = await h.store.listBooked();
      expect(saved).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.existing).toEqual(saved[0]);
      expect(await h.store.version()).toBe(1);
    });

    it('a newer waitlist line (new line id, same phone) can be booked again', async () => {
      await h.store.addBooked(booked('O1', '7'));
      const newer = booked('O2', '7', { lineId: 'W61' });
      expect(await h.store.addBooked(newer)).toEqual({ ok: true });
      expect(await h.store.listBooked()).toHaveLength(2);
      expect(await h.store.version()).toBe(2);
    });

    it('lists bookings oldest first', async () => {
      await h.store.addBooked(booked('O2', '2', { at: '2026-10-21T15:00:00.000Z' }));
      await h.store.addBooked(booked('O1', '1', { at: '2026-10-21T09:30:00.000Z' }));
      await h.store.addBooked(booked('O3', '3', { at: '2026-10-22T01:15:00.000Z' }));
      expect((await h.store.listBooked()).map((b) => b.openingId)).toEqual(['O1', 'O2', 'O3']);
    });

    it('undo removes the booking, keeps it in the history, and frees the opening and the person', async () => {
      const record = booked('O34', '1', { by: 'tanya@example.com' });
      await h.store.addBooked(record);
      expect(await h.store.removeBooked('O34')).toBe(true);
      expect(await h.store.listBooked()).toEqual([]);
      const history = await h.history();
      expect(history).toHaveLength(1);
      expect(history[0]!.record).toEqual(record);
      expect(Number.isNaN(Date.parse(history[0]!.undoneAt))).toBe(false);
      expect(await h.store.version()).toBe(2);
      // Nothing to undo: false, and no bump.
      expect(await h.store.removeBooked('O34')).toBe(false);
      expect(await h.store.removeBooked('O99')).toBe(false);
      expect(await h.store.version()).toBe(2);
      // The opening and the person can be booked again.
      expect(await h.store.addBooked(booked('O34', '1'))).toEqual({ ok: true });
      expect(await h.store.version()).toBe(3);
    });

    it('version goes up by one on every change and never on a refusal', async () => {
      const steps: Array<[() => Promise<unknown>, number]> = [
        [() => h.store.saveImport(makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z')), 1],
        [() => h.store.addBooked(booked('O1', '1')), 2],
        [() => h.store.addBooked(booked('O1', '2')), 2], // opening taken
        [() => h.store.addBooked(booked('O2', '1')), 2], // person taken
        [() => h.store.addBooked(booked('O2', '2')), 3],
        [() => h.store.removeBooked('O1'), 4],
        [() => h.store.removeBooked('O1'), 4], // nothing to undo
        [() => h.store.readingCache().set('k1', entry('claude')), 4], // readings are not screen data
        [() => h.store.saveImport(makeImport('20261022T100000000Z-bbbb', '2026-10-22T10:00:00.000Z')), 5],
      ];
      for (const [step, expected] of steps) {
        await step();
        expect(await h.store.version()).toBe(expected);
      }
    });

    it('reading cache: entries round-trip, survive a restart, list sorted, and the saved readings fill gaps', async () => {
      const cache = h.store.readingCache();
      expect(await cache.get('missing')).toBeUndefined();
      expect((await cache.get('seed-key'))?.by).toBe('saved');
      await cache.set('b-key', entry('claude', ['Quote not found in the notes.']));
      await cache.set('a-key', entry('claude'));
      expect(await cache.get('b-key')).toEqual(entry('claude', ['Quote not found in the notes.']));

      const after = h.reopen().readingCache();
      expect(await after.get('b-key')).toEqual(entry('claude', ['Quote not found in the notes.']));
      const all = await after.all();
      expect(Object.keys(all)).toEqual(['a-key', 'b-key', 'seed-key']);
      // A changed copy of what get() returned does not change the cache.
      const got = (await after.get('a-key'))!;
      got.problems.push('changed');
      expect((await after.get('a-key'))!.problems).toEqual([]);
    });

    it('restart safety: a new store on the same data sees every import, booking and the version', async () => {
      const imp = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
      await h.store.saveImport(imp);
      await h.store.addBooked(booked('O1', '1'));
      await h.store.addBooked(booked('O2', '2'));
      await h.store.removeBooked('O1');
      const again = h.reopen();
      expect(await again.latestImport()).toEqual(imp);
      expect((await again.listBooked()).map((b) => b.openingId)).toEqual(['O2']);
      expect(await again.version()).toBe(4);
      // The rules still hold on the new store.
      expect((await again.addBooked(booked('O2', '9'))).ok).toBe(false);
    });
  });
}

describe('SupabaseStore only', () => {
  it('addBooked only inserts: the database constraint decides, there is no check-then-insert', async () => {
    const db = new FakeSupabase(0);
    const store = new SupabaseStore(db, { seedReadingsFrom: seedFile });
    db.calls.length = 0;
    await store.addBooked(booked('O1', '1'));
    expect(db.calls).toEqual(['insert booked']);
  });

  it('a failed save throws, saves nothing and does not bump the version', async () => {
    const db = new FakeSupabase(0);
    const store = new SupabaseStore(db, { seedReadingsFrom: seedFile });
    db.failNext = { code: '08006', message: 'connection failure' };
    await expect(store.addBooked(booked('O1', '1'))).rejects.toThrow(/could not save the booking/);
    expect(await store.listBooked()).toEqual([]);
    expect(await store.version()).toBe(0);
  });

  it('error messages never contain the keys', async () => {
    const db = new FakeSupabase(0);
    const store = new SupabaseStore(db, { seedReadingsFrom: seedFile });
    db.failNext = { code: 'PGRST301', message: 'JWT expired' };
    const err = await store.version().catch((e: Error) => e);
    expect(String(err)).toMatch(/could not read the version/);
    expect(String(err)).not.toMatch(/eyJ|service_role|sb_secret/);
  });

  it('reads whole tables page by page (more rows than one page)', async () => {
    const db = new FakeSupabase(0);
    const store = new SupabaseStore(db, { seedReadingsFrom: seedFile });
    for (let i = 0; i < 1203; i++) {
      db.insertRow('booked', {
        opening_id: `O${i}`,
        person_phone_digits: `5065550${String(i).padStart(4, '0')}`,
        person_name: `P${i}`,
        line_id: `W${i}`,
        at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
        by: 'local',
      });
    }
    const list = await store.listBooked();
    expect(list).toHaveLength(1203);
    expect(list[0]!.openingId).toBe('O0');
    expect(list[1202]!.openingId).toBe('O1202');
    expect(list[0]!.at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('fetches the latest import files only when the latest id changed', async () => {
    const db = new FakeSupabase(0);
    const store = new SupabaseStore(db, { seedReadingsFrom: seedFile });
    await store.saveImport(makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z'));
    const other = new SupabaseStore(db, { seedReadingsFrom: seedFile });
    await other.latestImport();
    db.calls.length = 0;
    await other.latestImport();
    await other.latestImport();
    expect(db.calls).toEqual(['select imports', 'select imports']); // just the id check, twice
  });
});
