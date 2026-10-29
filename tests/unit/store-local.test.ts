// LocalStore (feature 6a): imports kept, one booking per opening, undo, version bumps, atomic files, temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStore } from '@/lib/storage/local';
import { getStore, localDataDir } from '@/lib/storage';
import type { StoredImport } from '@/lib/storage/types';
import type { BookedRecord } from '@/lib/types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlist-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const summary = {
  run: {
    openings: 1, withPeople: 1, nobody: 0, noShows: 0, linesRead: 1, peopleActive: 1, stale: 0, duplicates: 0,
    notRead: [], failed: [],
  },
  bookingExportDate: '2026-10-17',
  rows: { waitlist: 1, openings: 1, appointments: 1 },
};
const file = (name: string, text: string) => ({ name, sha256: `sha-${name}`, text });
const makeImport = (id: string, createdAt: string): StoredImport => ({
  id,
  runDate: '2026-10-21',
  createdAt,
  files: { waitlist: file('w.csv', 'line'), openings: file('o.csv', 'opening_id'), appointments: file('a.csv', 'appointment_id') },
  summary,
});
// A different person per opening by default (one live booking per person is its own rule, tested below).
const booked = (openingId: string, name = 'Amanda Bourgeois', person = openingId): BookedRecord => ({
  personPhoneDigits: `506555${String([...person].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 10000, 7)).padStart(4, '0')}`,
  personName: name,
  lineId: `W-${person}`,
  openingId,
  at: '2026-10-21T14:00:00.000Z',
  by: 'local',
});

describe('LocalStore imports', () => {
  it('starts empty at version 0', async () => {
    const s = new LocalStore(dir);
    expect(await s.latestImport()).toBeNull();
    expect(await s.version()).toBe(0);
    expect(await s.listBooked()).toEqual([]);
  });

  it('saves an import and returns it as the latest', async () => {
    const s = new LocalStore(dir);
    const imp = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
    await s.saveImport(imp);
    expect(await s.latestImport()).toEqual(imp);
    expect(await s.version()).toBe(1);
  });

  it('keeps every import; the latest wins', async () => {
    const s = new LocalStore(dir);
    const a = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
    const b = { ...makeImport('20261022T100000000Z-bbbb', '2026-10-22T10:00:00.000Z'), runDate: '2026-10-22' };
    await s.saveImport(a);
    await s.saveImport(b);
    expect((await s.latestImport())?.id).toBe(b.id);
    expect(await s.listImportIds()).toEqual([a.id, b.id]);
    expect(fs.existsSync(path.join(dir, 'imports', `${a.id}.json`))).toBe(true);
    expect(await s.version()).toBe(2);
  });

  it('never replaces a saved import and refuses unsafe ids', async () => {
    const s = new LocalStore(dir);
    const a = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
    await s.saveImport(a);
    await expect(s.saveImport(a)).rejects.toThrow(/never replaced/);
    await expect(s.saveImport({ ...a, id: '../evil' })).rejects.toThrow(/letters, digits/);
    expect(await s.version()).toBe(1);
  });
});

describe('LocalStore booked', () => {
  it('allows one booking per opening; a second is refused with the existing record', async () => {
    const s = new LocalStore(dir);
    expect(await s.addBooked(booked('O34'))).toEqual({ ok: true });
    const second = await s.addBooked(booked('O34', 'Someone Else'));
    expect(second).toEqual({ ok: false, existing: booked('O34') });
    expect(await s.listBooked()).toEqual([booked('O34')]);
    expect(await s.version()).toBe(1); // the refused one changed nothing
  });

  it('parallel bookings for the same opening: exactly one wins', async () => {
    const s = new LocalStore(dir);
    const results = await Promise.all([s.addBooked(booked('O35')), s.addBooked(booked('O35', 'B')), s.addBooked(booked('O35', 'C'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await s.listBooked()).toHaveLength(1);
  });

  it('one live booking per person: the same person on the same line cannot fill a second opening, even in a race', async () => {
    const s = new LocalStore(dir);
    const results = await Promise.all([s.addBooked(booked('O34', 'Amanda', 'amanda')), s.addBooked(booked('O35', 'Amanda', 'amanda'))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await s.listBooked()).toHaveLength(1);
    expect(await s.version()).toBe(1);
    // After a newer waitlist line (new line id) the same phone may be booked again.
    const newer = { ...booked('O36', 'Amanda', 'amanda'), lineId: 'W61' };
    expect(await s.addBooked(newer)).toEqual({ ok: true });
  });

  it('remove (undo) deletes the booking, keeps a history entry and bumps the version', async () => {
    const s = new LocalStore(dir);
    await s.addBooked(booked('O34'));
    await s.addBooked(booked('O36'));
    expect(await s.removeBooked('O34')).toBe(true);
    expect((await s.listBooked()).map((b) => b.openingId)).toEqual(['O36']);
    expect(await s.removeBooked('O34')).toBe(false);
    expect(await s.version()).toBe(3);
    const history = JSON.parse(fs.readFileSync(path.join(dir, 'booked-history.json'), 'utf8'));
    expect(history).toHaveLength(1);
    expect(history[0].record.openingId).toBe('O34');
    // After undo the opening can be booked again.
    expect(await s.addBooked(booked('O34'))).toEqual({ ok: true });
  });

  it('bumps the version on every change', async () => {
    const s = new LocalStore(dir);
    const seen = [await s.version()];
    await s.saveImport(makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z'));
    seen.push(await s.version());
    await s.addBooked(booked('O1'));
    seen.push(await s.version());
    await s.removeBooked('O1');
    seen.push(await s.version());
    await s.saveImport(makeImport('20261021T110000000Z-bbbb', '2026-10-21T11:00:00.000Z'));
    seen.push(await s.version());
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('LocalStore files', () => {
  it('survives a re-open: a new instance on the same folder sees everything', async () => {
    const a = new LocalStore(dir);
    const imp = makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z');
    await a.saveImport(imp);
    await a.addBooked(booked('O34'));
    const b = new LocalStore(dir);
    expect(await b.latestImport()).toEqual(imp);
    expect(await b.listBooked()).toEqual([booked('O34')]);
    expect(await b.version()).toBe(2);
    expect(await b.addBooked(booked('O34'))).toMatchObject({ ok: false });
  });

  it('writes whole files and leaves no temp files behind', async () => {
    const s = new LocalStore(dir);
    await s.saveImport(makeImport('20261021T100000000Z-aaaa', '2026-10-21T10:00:00.000Z'));
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.addBooked(booked(`O${i}`))));
    const all = fs.readdirSync(dir, { recursive: true }).map(String);
    expect(all.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    for (const f of ['booked.json', 'version.json', 'latest.json']) {
      expect(() => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).not.toThrow();
    }
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'booked.json'), 'utf8'))).toHaveLength(10);
    expect(await s.version()).toBe(11);
  });

  it('readings cache lives in the folder and is seeded from the saved sample readings', async () => {
    const s = new LocalStore(dir);
    const all = await s.readingCache().all();
    expect(Object.keys(all).length).toBe(45);
    expect(fs.existsSync(path.join(dir, 'readings-cache.json'))).toBe(true);
  });

  it('getStore uses SHORTLIST_DATA_DIR', async () => {
    const before = process.env.SHORTLIST_DATA_DIR;
    process.env.SHORTLIST_DATA_DIR = dir;
    try {
      expect(localDataDir()).toBe(path.resolve(dir));
      const s = getStore();
      expect(s).toBeInstanceOf(LocalStore);
      expect((s as LocalStore).dir).toBe(path.resolve(dir));
      expect(getStore()).toBe(s);
    } finally {
      if (before === undefined) delete process.env.SHORTLIST_DATA_DIR;
      else process.env.SHORTLIST_DATA_DIR = before;
    }
  });
});
