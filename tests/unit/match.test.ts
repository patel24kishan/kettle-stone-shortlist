// The matcher against Tanya's answer key. Rule source: ../../../rules.md Steps 3-4 and build-plan.md sections 5.4 and 6 Step 3.
// Pipeline: sample CSVs -> group -> saved readings (no Claude) -> people -> matchAll. Sample files are never modified:
// the saved readings are copied to a temp folder first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAppointments, parseCsv, parseOpenings, parseWaitlist } from '@/lib/csv';
import { buildPeople, groupLines } from '@/lib/import';
import { matchAll, matchOpening, passingIds } from '@/lib/match';
import { FileReadingCache } from '@/lib/readings/cache';
import { makeGetReading, readAll } from '@/lib/readings/reader';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { Opening, OpeningResult, Person, Reading, Settings } from '@/lib/types';

const RUN_DATE = '2026-10-21';
const RUN_YEAR = 2026;
const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const sampleText = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');

let TMP = '';
let openings: Opening[] = [];
let people: Person[] = [];
let readings = new Map<string, Reading | null>();
let results: OpeningResult[] = [];

/** The key's answer for each opening: line ids in the key's order ([] for "none"). */
const keyIds: Record<string, string[]> = {};
const sampleBytes = new Map<string, Buffer>();

beforeAll(async () => {
  for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(path.join(SAMPLE, f)));
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-match-'));
  const readingsPath = path.join(TMP, 'readings.json');
  fs.copyFileSync(path.join(SAMPLE, 'readings.json'), readingsPath);

  const lines = parseWaitlist(sampleText('waitlist-2026-10-21.csv'), RUN_YEAR);
  const groups = groupLines(lines);
  const read = await readAll(groups, { cache: new FileReadingCache(readingsPath), client: null, runYear: RUN_YEAR });
  const built = buildPeople(lines, {
    runDate: RUN_DATE,
    appointments: parseAppointments(sampleText('appointments-2026-09-21-to-2026-10-17.csv')),
    getReading: makeGetReading(read, groups),
  });
  people = built.people;
  readings = new Map([...read.entries()].map(([k, r]) => [k, r.reading]));
  openings = parseOpenings(sampleText('late-openings-2026-09-21-to-2026-10-17.csv'));
  results = matchAll(openings, people, readings, DEFAULT_SETTINGS);

  for (const row of parseCsv(sampleText('answer-key-tanya.csv')).filter((r) => r.type === 'opening')) {
    keyIds[row.id!] = row.answer === 'none' ? [] : row.answer!.split('; ').map((s) => s.split(' ')[0]!);
  }
});

afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(path.join(SAMPLE, f)).equals(bytes), f).toBe(true);
});

const byId = (id: string) => results.find((r) => r.openingId === id)!;
const shown = (r: OpeningResult) => r.suggestions.map((s) => s.lineId);

describe('gate: the sample openings against Tanya\'s key (default settings)', () => {
  it('has 44 openings and 44 key rows, in the same order', () => {
    expect(openings).toHaveLength(44);
    expect(Object.keys(keyIds)).toHaveLength(44);
    expect(results.map((r) => r.openingId)).toEqual(openings.map((o) => o.opening_id));
  });

  it('44/44: the full passing list equals the key\'s full list, in order', () => {
    const wrong = results
      .filter((r) => passingIds(r).join() !== keyIds[r.openingId]!.join())
      .map((r) => `${r.openingId}: ours=${passingIds(r).join(' ') || 'none'} key=${keyIds[r.openingId]!.join(' ') || 'none'}`);
    expect(wrong).toEqual([]);
  });

  it('44/44: the suggestions equal the key\'s first 3', () => {
    const wrong = results
      .filter((r) => shown(r).join() !== keyIds[r.openingId]!.slice(0, 3).join())
      .map((r) => r.openingId);
    expect(wrong).toEqual([]);
  });

  it('44/44 on the Friday rule: every name shown is on the key\'s list; nobody means none', () => {
    const wrong = results.filter((r) => {
      const keyList = keyIds[r.openingId]!;
      const names = shown(r);
      return names.length ? !names.every((id) => keyList.includes(id)) : keyList.length !== 0;
    });
    expect(wrong.map((r) => r.openingId)).toEqual([]);
  });

  it('all 8 no-shows get nobody with the no-show reason', () => {
    const noShows = openings.filter((o) => o.kind === 'no-show');
    expect(noShows).toHaveLength(8);
    for (const o of noShows) {
      const r = byId(o.opening_id);
      expect(r.suggestions).toEqual([]);
      expect(r.nobodyReason).toBe('No-show: there is no time to offer it.');
    }
  });

  it('O31 and O40 are nobody; O30 has one name (W46); O32 has two (W42, W49)', () => {
    for (const id of ['O31', 'O40']) {
      expect(byId(id).suggestions).toEqual([]);
      expect(byId(id).nobodyReason).toBe('No one on the waitlist can take this opening.');
    }
    expect(shown(byId('O30'))).toEqual(['W46']);
    expect(shown(byId('O32'))).toEqual(['W42', 'W49']);
  });

  it('never shows more than 3, in waitlist order, with name and phone; nobodyReason only when empty', () => {
    for (const r of results) {
      expect(r.suggestions.length).toBeLessThanOrEqual(3);
      const ns = r.suggestions.map((s) => Number(s.lineId.slice(1)));
      expect([...ns].sort((a, b) => a - b)).toEqual(ns);
      for (const s of r.suggestions) {
        expect(s.name.length).toBeGreaterThan(0);
        expect(s.phoneDisplay).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
      }
      expect(r.nobodyReason === null).toBe(r.suggestions.length > 0);
    }
  });

  it('Josée\'s openings carry the note, others do not', () => {
    for (const o of openings) expect(byId(o.opening_id).joseeNote).toBe(o.therapist === 'Josée Landry');
    expect(results.some((r) => r.joseeNote)).toBe(true);
  });

  it('the waitlist as it stands on the run date is used: Lise (W57, added Oct 13) counts for O01 on Sep 21', () => {
    expect(passingIds(byId('O01'))).toContain('W57');
  });

  it('is deterministic: the same inputs give the same results', () => {
    expect(matchAll(openings, people, readings, DEFAULT_SETTINGS)).toEqual(results);
    expect(matchAll(openings, [...people].reverse(), readings, DEFAULT_SETTINGS)).toEqual(results);
  });

  it('matchOpening alone equals the matchAll entry; settings default to DEFAULT_SETTINGS', () => {
    const o = openings[0]!;
    expect(matchOpening(o, people, readings)).toEqual(results[0]);
  });

  it('tagged people appear in the trace and fail at notTagged', () => {
    const tagged = people.filter((p) => p.tags.length > 0);
    expect(tagged.length).toBeGreaterThan(0);
    const trace = byId('O01').trace;
    for (const p of tagged) {
      const t = trace.find((x) => x.lineId === p.newestId)!;
      expect(t.checks.at(-1)).toMatchObject({ check: 'notTagged', pass: false });
    }
  });

  it('a person whose notes were not read is never offered', () => {
    const none = new Map<string, Reading | null>();
    for (const r of matchAll(openings, people, none, DEFAULT_SETTINGS)) {
      expect(r.suggestions).toEqual([]);
    }
    const t = matchOpening(openings[0]!, people, none).trace.find((x) => !x.checks.some((c) => c.check === 'notTagged' && !c.pass))!;
    expect(t.checks.at(-1)).toMatchObject({ check: 'hasReading', pass: false, reason: 'Notes not read yet.' });
  });
});

describe('settings are wired in', () => {
  const full = (rs: OpeningResult[]) => rs.map((r) => passingIds(r).join());
  const changed = (s: Settings) => {
    const base = full(results); // read at test time, after beforeAll has run
    const rs = matchAll(openings, people, readings, s);
    return openings.filter((_, i) => full(rs)[i] !== base[i]).map((o) => o.opening_id);
  };

  it('the default settings reproduce the key', () => {
    expect(DEFAULT_SETTINGS).toEqual({ noticeFrom: 'cancelled', allowLongerOpening: true, noticeEqualIsEnough: true });
    expect(openings.every((o, i) => passingIds(results[i]!).join() === keyIds[o.opening_id]!.join())).toBe(true);
  });

  it('allowLongerOpening: false changes the full list for 20 openings', () => {
    expect(changed({ ...DEFAULT_SETTINGS, allowLongerOpening: false })).toHaveLength(20);
  });

  it('noticeFrom: desk_free changes some openings, including O03', () => {
    const ids = changed({ ...DEFAULT_SETTINGS, noticeFrom: 'desk_free' });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('O03');
  });

  it('noticeEqualIsEnough: false never adds a name (it can only remove)', () => {
    const rs = matchAll(openings, people, readings, { ...DEFAULT_SETTINGS, noticeEqualIsEnough: false });
    rs.forEach((r, i) => {
      const was = new Set(passingIds(results[i]!));
      for (const id of passingIds(r)) expect(was.has(id)).toBe(true);
    });
  });
});

describe('privacy: reasons carry no health details or note text', () => {
  const reasons = () => results.flatMap((r) => r.trace.flatMap((t) => t.checks.map((c) => c.reason)));

  it('has reasons to look at', () => expect(reasons().length).toBeGreaterThan(1000));

  it('no reason mentions a waitlist health word', () => {
    const banned = /pregnan|prenatal|sciatica|mva|fibro|whiplash|surgery|injur|baby/i;
    expect(reasons().filter((x) => banned.test(x))).toEqual([]);
  });

  it('no reason contains a waitlist note', () => {
    const notes = parseWaitlist(sampleText('waitlist-2026-10-21.csv'), RUN_YEAR)
      .map((l) => l.notes.trim())
      .filter((n) => n.length >= 8);
    const all = reasons().join('\n');
    for (const n of notes) expect(all, n).not.toContain(n);
  });

  it('suggestions and nobody reasons carry only name, phone and line id', () => {
    for (const r of results) {
      for (const s of r.suggestions) expect(Object.keys(s).sort()).toEqual(['lineId', 'name', 'phoneDisplay']);
    }
  });
});
