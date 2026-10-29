// The API route handlers (feature 6a), called directly with Request objects, on a temp store with no Claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as importPOST } from '@/app/api/import/route';
import { GET as adminGET } from '@/app/api/admin/route';
import { GET as stateGET } from '@/app/api/state/route';
import { GET as verdictsGET } from '@/app/api/line-verdicts.csv/route';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const NAMES = {
  waitlist: 'waitlist-2026-10-21.csv',
  openings: 'late-openings-2026-09-21-to-2026-10-17.csv',
  appointments: 'appointments-2026-09-21-to-2026-10-17.csv',
};
const read = (f: string) => fs.readFileSync(SAMPLE + f, 'utf8');
const csvFile = (text: string, name: string) => new File([text], name, { type: 'text/csv' });

function importRequest(overrides: Partial<Record<'waitlist' | 'openings' | 'appointments', File | null>> = {}, runDate = '2026-10-21') {
  const form = new FormData();
  for (const kind of ['waitlist', 'openings', 'appointments'] as const) {
    const file = kind in overrides ? overrides[kind] : csvFile(read(NAMES[kind]), NAMES[kind]);
    if (file) form.append(kind, file);
  }
  form.append('runDate', runDate);
  return new Request('http://localhost/api/import', { method: 'POST', body: form });
}

let dir: string;
const env = { data: process.env.SHORTLIST_DATA_DIR, noClaude: process.env.SHORTLIST_NO_CLAUDE };
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlist-api-'));
  process.env.SHORTLIST_DATA_DIR = dir;
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
describe('API routes', () => {
  it('before any import: admin is empty, state has no import, line verdicts 404', async () => {
    expect(await (await adminGET()).json()).toEqual({ empty: true });
    expect(await (await stateGET()).json()).toEqual({ version: 0, import: null });
    expect((await verdictsGET()).status).toBe(404);
  });

  it('POST /api/import with a bad waitlist: 400 naming the missing column, nothing saved', async () => {
    const bad = read(NAMES.waitlist).replace(/^line,added,name,phone,notes/, 'line,added,name,telephone,notes');
    const res = await importPOST(importRequest({ waitlist: csvFile(bad, 'bad-waitlist.csv') }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.problems).toEqual([{ kind: 'waitlist', missing: ['phone'] }]);
    expect(body.message).toContain('phone');
    expect(body.message).toContain('bad-waitlist.csv');
    expect(body.files.find((f: { kind: string }) => f.kind === 'waitlist').check).toBe('Missing column(s): phone');
    expect((await (await stateGET()).json()).version).toBe(0);
  });

  it('POST /api/import with a file missing: 400', async () => {
    const res = await importPOST(importRequest({ openings: null }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('Late openings CSV');
  });

  it('POST /api/import with the sample: 200 with the counts', async () => {
    const res = await importPOST(importRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.view.counts).toEqual({ linesRead: 60, peopleReady: 30, repeatLinesMerged: 10, staleLines: 20, notRead: 0 });
    expect(body.import.files.waitlist.name).toBe(NAMES.waitlist);
    expect(body.view.claudeConnected).toBe(false);
    // The response never carries the files' text or the run's lines (notes).
    expect(JSON.stringify(body)).not.toContain('"text"');
    expect(JSON.stringify(body)).not.toContain('"notes"');
  });

  it('GET /api/admin returns the view of the latest import', async () => {
    const res = await adminGET();
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.counts.peopleReady).toBe(30);
    expect(view.people).toHaveLength(30);
    expect(view.import.runDate).toBe('2026-10-21');
    expect(view.files.map((f: { check: string }) => f.check)).toEqual([
      '60 lines · columns OK',
      '44 openings · columns OK',
      '595 appointments · columns OK',
    ]);
  });

  it('GET /api/state returns the version and the import info', async () => {
    const state = await (await stateGET()).json();
    expect(state.version).toBe(1);
    expect(state.import).toMatchObject({ runDate: '2026-10-21', bookingExportDate: expect.stringMatching(/^2026-10-\d\d$/) });
    expect(Object.keys(state.import).sort()).toEqual(['bookingExportDate', 'createdAt', 'files', 'id', 'runDate']);
    expect(state.import.files.appointments).toEqual({ name: NAMES.appointments, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('GET /api/line-verdicts.csv: header + 60 lines, same reasons as the CLI', async () => {
    const res = await verdictsGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('line_verdicts-2026-10-21.csv');
    const text = await res.text();
    const rows = text.trimEnd().split('\n');
    expect(rows).toHaveLength(61);
    expect(rows[0]).toBe('line,verdict,reason');
    expect(rows).toContain('W23,stale,Moved away.');
    expect(rows).toContain('W02,duplicate of W51,');
  });
});
