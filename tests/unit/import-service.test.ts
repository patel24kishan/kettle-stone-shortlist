// B5 import service, the current run and the admin view (feature 6a), on the sample files with no Claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAppointments } from '@/lib/csv';
import { MemoryReadingCache } from '@/lib/readings/cache';
import type { ReadingCacheEntry } from '@/lib/readings/cache';
import { resultsCsv, runShortlist } from '@/lib/run';
import { LocalStore } from '@/lib/storage/local';
import { getCurrent, getCurrentRun } from '@/lib/server/current';
import { bookingExportDate, importFiles } from '@/lib/server/import-service';
import type { ImportInput } from '@/lib/server/import-service';
import { getAdminView, getState } from '@/lib/server/queries';
import type { AdminView } from '@/lib/server/views';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const NAMES = {
  waitlist: 'waitlist-2026-10-21.csv',
  openings: 'late-openings-2026-09-21-to-2026-10-17.csv',
  appointments: 'appointments-2026-09-21-to-2026-10-17.csv',
};
const read = (f: string) => fs.readFileSync(SAMPLE + f, 'utf8');
const sampleInput = (): ImportInput => ({
  waitlist: { name: NAMES.waitlist, text: read(NAMES.waitlist) },
  openings: { name: NAMES.openings, text: read(NAMES.openings) },
  appointments: { name: NAMES.appointments, text: read(NAMES.appointments) },
  runDate: '2026-10-21',
});
const HEALTH = [
  'pregnant', 'surgery', 'post-op', 'MVA', 'sciatica', 'cancer', 'fibro', 'concussion', 'migraine', 'TMJ', 'knee',
  'hip', 'hamstring', 'rotator', 'shoulder',
];
const healthHits = (text: string) =>
  HEALTH.filter((w) => new RegExp(`(^|[^a-z0-9])${w.replace('-', '\\-')}s?($|[^a-z0-9])`, 'i').test(text));

let dir: string;
let store: LocalStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlist-import-'));
  store = new LocalStore(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function importSample(): Promise<AdminView> {
  const res = await importFiles(sampleInput(), { store, client: null });
  if (!res.ok) throw new Error(res.message);
  return res.view;
}

describe('importFiles on the sample', () => {
  it('counts 60 / 30 / 10 / 20 and nobody unread', async () => {
    const view = await importSample();
    expect(view.counts).toEqual({ linesRead: 60, peopleReady: 30, repeatLinesMerged: 10, staleLines: 20, notRead: 0 });
    expect(view.notReadWarning).toBeNull();
  });

  it('shows each file with its check and the booking export date from the file', async () => {
    const view = await importSample();
    expect(view.files.map((f) => [f.name, f.check])).toEqual([
      [NAMES.waitlist, '60 lines · columns OK'],
      [NAMES.openings, '44 openings · columns OK'],
      [NAMES.appointments, '595 appointments · columns OK'],
    ]);
    const latest = parseAppointments(read(NAMES.appointments))
      .map((a) => a.booked_at.slice(0, 10))
      .sort()
      .at(-1);
    expect(view.import.bookingExportDate).toBe(latest);
    expect(view.import.bookingExportDate).toMatch(/^2026-10-1\d$/);
    expect(bookingExportDate(read(NAMES.appointments))).toBe(latest);
    expect(view.import.runDate).toBe('2026-10-21');
  });

  it('has a people table of the 30 active people, in line order, with merged lines named', async () => {
    const view = await importSample();
    expect(view.people).toHaveLength(30);
    const lines = view.people.map((p) => Number(p.line.slice(1)));
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    const w42 = view.people.find((p) => p.line === 'W42')!;
    expect(w42).toMatchObject({ merged: 'merged W26', name: 'Amanda Bourgeois', phone: '(506) 555-0125' });
    expect(w42.therapist.value).toBe('Rachel or Josée');
    const w12 = view.people.find((p) => p.line === 'W12')!;
    expect(w12.merged).toBe('');
    expect(w12.availability.value).toBe('Not Thu · start 3:30 PM or later');
  });

  it("shows W40's therapist as the clinic rule with the wording hidden", async () => {
    const view = await importSample();
    const w40 = view.people.find((p) => p.line === 'W40')!;
    expect(w40.therapist).toEqual({ value: 'Amira or Kelsey', source: 'clinic rule · wording hidden' });
  });

  it('lists who is not offered, and why', async () => {
    const view = await importSample();
    const why = (id: string) => view.notOffered.find((r) => r.lineIds.includes(id))?.why;
    expect(why('W23')).toBe('Moved away.');
    expect(why('W15')).toMatch(/^Booked since: Sep 24 as Melanie Arsenault\./);
    expect(why('W07')).toMatch(/No call-back/);
    expect(view.notOffered.find((r) => r.lineIds.includes('W50'))!.who).toBe('W13, W50 Kim Belliveau');
    // 15 stale people (20 stale lines); nobody active is in the list.
    expect(view.notOffered).toHaveLength(15);
    expect(view.notOffered.every((r) => r.kind === 'stale')).toBe(true);
  });

  it('saves the import: files kept as given, latest import, version bumped', async () => {
    await importSample();
    const imp = (await store.latestImport())!;
    expect(imp.files.waitlist.text).toBe(read(NAMES.waitlist).replace(/^﻿/, ''));
    expect(imp.files.openings.name).toBe(NAMES.openings);
    expect(imp.files.appointments.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.version()).toBe(1);
    const state = await getState(store);
    expect(state.import).toMatchObject({ id: imp.id, runDate: '2026-10-21', bookingExportDate: imp.summary.bookingExportDate });
    expect(JSON.stringify(state)).not.toContain('"text"');
  });

  it('a waitlist without the notes column returns the problem and saves nothing', async () => {
    const input = sampleInput();
    input.waitlist.text = input.waitlist.text.replace(/^line,added,name,phone,notes/, 'line,added,name,phone,memo');
    const res = await importFiles(input, { store, client: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.problems).toEqual([{ kind: 'waitlist', missing: ['notes'] }]);
    expect(res.message).toContain('notes');
    expect(res.message).toContain(NAMES.waitlist);
    expect(res.files.find((f) => f.kind === 'waitlist')).toMatchObject({ ok: false, check: 'Missing column(s): notes' });
    expect(res.files.find((f) => f.kind === 'openings')).toMatchObject({ ok: true, check: '44 openings · columns OK' });
    expect(await store.latestImport()).toBeNull();
    expect(await store.version()).toBe(0);
    expect(fs.existsSync(path.join(dir, 'imports'))).toBe(false);
  });

  it('a run date that is not a real date is refused', async () => {
    const res = await importFiles({ ...sampleInput(), runDate: '2026-02-30' }, { store, client: null });
    expect(res.ok).toBe(false);
    expect(await store.latestImport()).toBeNull();
  });

  it('marks people whose notes were not read, warns, and never puts them in the table', async () => {
    const input = sampleInput();
    // A new line for someone new: no saved reading, no Claude.
    const eol = input.waitlist.text.includes('\r\n') ? '\r\n' : '\n';
    input.waitlist.text = `${input.waitlist.text.trimEnd()}${eol}61,Oct 20,Nora Test,(506) 555-0199,any 60${eol}`;
    const res = await importFiles(input, { store, client: null });
    if (!res.ok) throw new Error(res.message);
    expect(res.view.counts.notRead).toBe(1);
    expect(res.view.counts.peopleReady).toBe(30);
    expect(res.view.notReadWarning).toBe("1 person's notes weren't read because Claude isn't connected; they won't be suggested.");
    expect(res.view.notOffered.find((r) => r.lineIds.includes('W61'))).toMatchObject({ kind: 'not read', why: 'Notes not read yet, so not offered.' });
    expect(res.view.people.some((p) => p.line === 'W61')).toBe(false);
  });
});

describe('getCurrentRun', () => {
  it('equals runShortlist on the same files (CLI parity)', async () => {
    await importSample();
    const current = (await getCurrentRun(store))!;
    const savedReadings = JSON.parse(read('readings.json')) as Record<string, ReadingCacheEntry>;
    const cli = await runShortlist({
      waitlistText: read(NAMES.waitlist),
      openingsText: read(NAMES.openings),
      appointmentsText: read(NAMES.appointments),
      runDate: '2026-10-21',
      cache: new MemoryReadingCache(savedReadings),
      client: null,
      booked: [],
    });
    expect(current.results).toEqual(cli.results);
    expect(resultsCsv(current.results)).toBe(resultsCsv(cli.results));
    expect(current.verdicts).toEqual(cli.verdicts);
    expect(current.summary).toEqual(cli.summary);
  });

  it('is null before any import, and memoised by (import, version)', async () => {
    expect(await getCurrentRun(store)).toBeNull();
    expect(await getAdminView(store)).toEqual({ empty: true });
    await importSample();
    const a = await getCurrent(store);
    const b = await getCurrent(store);
    expect(b).toBe(a);
  });

  it('a Booked record changes the current run (Amanda leaves O34) and bumps the version', async () => {
    await importSample();
    const before = (await getCurrentRun(store))!;
    const o34 = (r: typeof before) => r.results.find((x) => x.openingId === 'O34')!.suggestions.map((s) => s.lineId);
    expect(o34(before)).toContain('W42');
    const v = await store.version();

    const add = await store.addBooked({
      personPhoneDigits: '5065550125',
      personName: 'Amanda Bourgeois',
      lineId: 'W42',
      openingId: 'O35',
      at: '2026-10-21T14:00:00.000Z',
      by: 'local',
    });
    expect(add).toEqual({ ok: true });
    expect(await store.version()).toBe(v + 1);

    const after = (await getCurrentRun(store))!;
    expect(after).not.toBe(before);
    expect(o34(after)).not.toContain('W42');
    expect(after.results.every((r) => r.suggestions.every((s) => s.lineId !== 'W42'))).toBe(true);

    const view = (await getAdminView(store)) as AdminView;
    expect(view.people.some((p) => p.line === 'W42')).toBe(false);
    const row = view.notOffered.find((r) => r.lineIds.includes('W42'))!;
    expect(row.kind).toBe('booked');
    expect(row.why).toMatch(/^Booked through the tool for O35 on Oct 21\./);

    // Booked survives a new import of the same files.
    await importSample();
    expect(o34((await getCurrentRun(store))!)).not.toContain('W42');

    // Undo brings her back.
    expect(await store.removeBooked('O35')).toBe(true);
    expect(o34((await getCurrentRun(store))!)).toContain('W42');
  });
});

describe('privacy', () => {
  it('the whole admin view has no health words and no note text', async () => {
    const view = await importSample();
    const json = JSON.stringify(view);
    expect(healthHits(json)).toEqual([]);
    const fromStore = JSON.stringify(await getAdminView(store));
    expect(healthHits(fromStore)).toEqual([]);
    // Whole notes never appear (spot-check a few distinctive ones).
    const notes = read(NAMES.waitlist)
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.split(',').slice(4).join(',').replace(/^"|"$/g, '').trim())
      .filter((n) => n.length > 25);
    expect(notes.length).toBeGreaterThan(5);
    for (const n of notes) expect(json).not.toContain(n);
  });
});
