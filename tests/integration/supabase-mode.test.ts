// Supabase mode end to end (feature 6e), with no live project: the Supabase env vars are set, so getStore() picks the
// SupabaseStore; its client is swapped for the in-memory fake of supabase/schema.sql. The real routes import the
// sample, search, book (recording the staff login the proxy passed on), refuse a second booking, undo, and the
// screens agree with the local store on the same files.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeSupabase } from '../fakes/fake-supabase';

const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fake.db }));
// Each route also checks the staff session itself (src/lib/supabase/require-staff.ts). No live project, so the auth
// call is mocked: signed in unless a test sets auth.signedIn = false.
const auth = vi.hoisted(() => ({ signedIn: true }));
vi.mock('@supabase/ssr', () => ({
  parseCookieHeader: (header: string) =>
    header ? header.split(/;\s*/).map((p) => ({ name: p.split('=')[0]!, value: p.split('=').slice(1).join('=') })) : [],
  createServerClient: () => ({
    auth: {
      getClaims: async () =>
        auth.signedIn ? { data: { claims: { email: 'tanya@kettleandstone.ca' } }, error: null } : { data: null, error: null },
    },
  }),
}));

const { POST: importPOST } = await import('@/app/api/import/route');
const { POST: fileSearchPOST } = await import('@/app/api/search/file/route');
const { DELETE: bookedDELETE, POST: bookedPOST } = await import('@/app/api/booked/route');
const { GET: stateGET } = await import('@/app/api/state/route');
const { SupabaseStore, getStore, storeKind } = await import('@/lib/storage');
const { STAFF_HEADER } = await import('@/lib/supabase/staff');
const { runShortlist, resultsCsv } = await import('@/lib/run');
const { openRunCache } = await import('@/lib/cache-setup');

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const NAMES = {
  waitlist: 'waitlist-2026-10-21.csv',
  openings: 'late-openings-2026-09-21-to-2026-10-17.csv',
  appointments: 'appointments-2026-09-21-to-2026-10-17.csv',
};
const read = (f: string) => fs.readFileSync(SAMPLE + f, 'utf8');

function importRequest() {
  const form = new FormData();
  for (const kind of ['waitlist', 'openings', 'appointments'] as const) {
    form.append(kind, new File([read(NAMES[kind])], NAMES[kind], { type: 'text/csv' }));
  }
  form.append('runDate', '2026-10-21');
  return new Request('http://localhost/api/import', { method: 'POST', body: form });
}
const bookReq = (openingId: string, lineId: string, staff?: string) =>
  new Request('http://localhost/api/booked', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(staff ? { [STAFF_HEADER]: encodeURIComponent(staff) } : {}) },
    body: JSON.stringify({ openingId, lineId }),
  });
const undoReq = (openingId: string) => new Request(`http://localhost/api/booked?openingId=${openingId}`, { method: 'DELETE' });
const fileReq = () => new Request('http://localhost/api/search/file', { method: 'POST', body: new FormData() });

const ENV = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SHORTLIST_DATA_DIR', 'SHORTLIST_NO_CLAUDE'] as const;
const saved: Record<string, string | undefined> = {};
let db: FakeSupabase;
let cliCsv: string;

beforeAll(async () => {
  for (const n of ENV) saved[n] = process.env[n];
  delete process.env.SHORTLIST_DATA_DIR;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake-project-for-tests.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.SHORTLIST_NO_CLAUDE = '1';
  db = new FakeSupabase(1);
  fake.db = db;

  const tmp = fs.mkdtempSync(`${process.env.TEMP ?? '/tmp'}/shortlist-supa-cli-`);
  const run = await runShortlist({
    waitlistText: read(NAMES.waitlist),
    openingsText: read(NAMES.openings),
    appointmentsText: read(NAMES.appointments),
    runDate: '2026-10-21',
    cache: openRunCache(`${tmp}/cache.json`),
    client: null,
    booked: [],
  });
  cliCsv = resultsCsv(run.results);
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => {
  for (const n of ENV) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('the app on the Supabase store (fake database)', () => {
  it('picks the Supabase store', () => {
    expect(storeKind()).toBe('supabase');
    expect(getStore()).toBeInstanceOf(SupabaseStore);
  });

  it('imports the sample into the database and bumps the version', async () => {
    const res = await importPOST(importRequest());
    expect(res.status).toBe(200);
    expect(db.tables.imports).toHaveLength(1);
    expect((db.tables.imports[0]!.files as Record<string, { text: string }>).waitlist.text).toBe(read(NAMES.waitlist).replace(/^﻿/, ''));
    const state = await (await stateGET()).json();
    expect(state.version).toBe(1);
    expect(state.import.runDate).toBe('2026-10-21');
  });

  it('screens on the Supabase store give the same names as the CLI', async () => {
    const body = await (await fileSearchPOST(fileReq())).json();
    expect(body.resultsCsv).toBe(cliCsv);
  });

  it('Booked saves a row with the staff login, a second tap is refused, and undo keeps the history', async () => {
    const res = await bookedPOST(bookReq('O34', 'W42', 'tanya@kettleandstone.ca'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.record).toMatchObject({ openingId: 'O34', lineId: 'W42', personName: 'Amanda Bourgeois', by: 'tanya@kettleandstone.ca' });
    expect(db.tables.booked).toHaveLength(1);
    expect(db.tables.booked[0]!.by).toBe('tanya@kettleandstone.ca');
    expect(body.version).toBe(2);

    const again = await bookedPOST(bookReq('O34', 'W33', 'bethany@kettleandstone.ca'));
    expect(again.status).toBe(409);
    expect((await again.json()).message).toBe('Already filled by Amanda Bourgeois (line W42).');
    expect(db.tables.booked).toHaveLength(1);

    const after = await (await fileSearchPOST(fileReq())).json();
    expect(after.resultsCsv).not.toContain('W42');

    expect((await bookedDELETE(undoReq('O34'))).status).toBe(200);
    expect(db.tables.booked).toHaveLength(0);
    expect(db.tables.booked_history).toHaveLength(1);
    expect((db.tables.booked_history[0]!.record as { by: string }).by).toBe('tanya@kettleandstone.ca');
    expect((await (await stateGET()).json()).version).toBe(3);
    expect((await (await fileSearchPOST(fileReq())).json()).resultsCsv).toBe(cliCsv);
  });

  it('a booking without a staff login (no header) is recorded as "local"', async () => {
    const res = await bookedPOST(bookReq('O34', 'W42'));
    expect((await res.json()).record.by).toBe('local');
    expect((await bookedDELETE(undoReq('O34'))).status).toBe(200);
  });

  it('two devices booking the same opening at once: one 200, the rest 409', async () => {
    const lines = ['W42', 'W33'];
    const results = await Promise.all(lines.map((l, i) => bookedPOST(bookReq('O34', l, `staff${i}@example.com`))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect(statuses.slice(1).every((s) => s === 409 || s === 404)).toBe(true);
    expect(db.tables.booked).toHaveLength(1);
  });

  it('signed out, every route answers 401 and changes nothing', async () => {
    auth.signedIn = false;
    try {
      const before = { booked: db.tables.booked.length, imports: db.tables.imports.length };
      for (const res of [await importPOST(importRequest()), await stateGET(), await fileSearchPOST(fileReq()), await bookedPOST(bookReq('O34', 'W42'))]) {
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ ok: false, signedOut: true });
      }
      expect({ booked: db.tables.booked.length, imports: db.tables.imports.length }).toEqual(before);
    } finally {
      auth.signedIn = true;
    }
  });
});
