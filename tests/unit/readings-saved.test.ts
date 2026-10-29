// The saved sample readings (data/sample/readings.json) against reference/rules-check.mjs `P` and against
// Tanya's answer key through Feature 1 (60/60 line verdicts), with no Claude client.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAppointments, parseCsv, parseWaitlist } from '@/lib/csv';
import { buildPeople, groupLines } from '@/lib/import';
import { THERAPISTS } from '@/lib/types';
import type { Day, Reading, Therapist } from '@/lib/types';
import { FileReadingCache } from '@/lib/readings/cache';
import { readingKey } from '@/lib/readings/hash';
import { makeGetReading, readAll } from '@/lib/readings/reader';
import { hasHealthWord, validateReading } from '@/lib/readings/validate';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const READINGS = SAMPLE + 'readings.json';
const sample = (f: string) => fs.readFileSync(SAMPLE + f, 'utf8');
const lines = parseWaitlist(sample('waitlist-2026-10-21.csv'), 2026);
const groups = groupLines(lines);
const newest = (g: typeof lines) => g[g.length - 1]!.id;

// ---- expectation table: a copy of reference/rules-check.mjs `P` and PREGNANT ----------------------------
const T = { J: 'Josée Landry', A: 'Amira Haddad', K: 'Kelsey Babineau', R: 'Rachel Thibodeau', D: 'Dave Melanson', M: 'Marc Cormier' } as const;
const FEM: Therapist[] = [T.J, T.A, T.K, T.R];
const ALL: Therapist[] = Object.values(T);
const t = (s: string): Therapist[] => s.split('').map((c) => T[c as keyof typeof T]);
const WK: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
interface P {
  ther: Therapist[]; len: number[]; only?: boolean; days?: Day[]; notDays?: Day[]; after?: string; before?: string;
  startBy?: string; endBy?: string; notice?: number; nextDay?: boolean; from?: string;
}
const P: Record<string, P> = {
  W10: { ther: t('AK'), len: [60], days: WK },
  W12: { ther: ALL.filter((x) => x !== T.D), len: [60], notDays: ['Thu'], after: '15:30' },
  W14: { ther: t('J'), len: [45, 60], notice: 3 },
  W18: { ther: t('M'), len: [60], before: '12:00', notice: 0.5 },
  W20: { ther: FEM, len: [60], days: ['Tue', 'Thu'] },
  W24: { ther: ALL, len: [60], after: '17:00' },
  W28: { ther: ALL, len: [90], only: true, days: ['Sat'] },
  W33: { ther: ALL.filter((x) => x !== T.D), len: [60], notDays: ['Mon'], before: '12:00' },
  W36: { ther: t('A'), len: [45], after: '10:00' },
  W37: { ther: ALL, len: [60], days: ['Fri'], after: '15:00' },
  W38: { ther: t('R'), len: [60], after: '18:00' },
  W39: { ther: ALL, len: [30, 45], days: WK, after: '12:00', startBy: '12:30', notice: 0.5 },
  W40: { ther: t('AK'), len: [60], notice: 3 },
  W42: { ther: t('RJ'), len: [60] },
  W43: { ther: t('KA'), len: [60], endBy: '14:30' },
  W45: { ther: t('JA'), len: [60], notDays: ['Fri'] },
  W46: { ther: t('MD'), len: [60] },
  W47: { ther: t('D'), len: [60, 90], after: '16:00' },
  W48: { ther: t('JR'), len: [60], before: '12:00' },
  W49: { ther: FEM, len: [45], days: ['Wed', 'Fri'], notice: 4 },
  W51: { ther: ALL, len: [60], days: ['Mon', 'Wed'], before: '12:00' },
  W52: { ther: t('KJ'), len: [60], days: ['Wed', 'Fri'] },
  W53: { ther: ALL, len: [60, 90], notDays: ['Sat'], from: '2026-10-10' },
  W54: { ther: ALL.filter((x) => x !== T.D), len: [90], only: true, after: '16:00' },
  W55: { ther: t('RA'), len: [60], nextDay: true },
  W56: { ther: t('A'), len: [60], days: ['Mon', 'Tue'] },
  W57: { ther: t('DJ'), len: [60], after: '12:00', notice: 2 },
  W58: { ther: t('D'), len: [90], only: true, days: ['Tue', 'Fri'] },
  W59: { ther: ALL, len: [45], days: ['Mon', 'Tue'], after: '17:00', notice: 1 },
  W60: { ther: ALL, len: [60], notDays: ['Thu'], before: '12:00' },
};
const PREGNANT = new Set(['W10', 'W40']);

// Stale people: what Feature 1 needs from the readings.
const STALE: Record<string, { gone?: Reading['gone']['value']; until?: string }> = {
  W23: { gone: 'moved' },
  W31: {}, W01: {}, W03: {}, W07: {}, W08: {}, W15: {}, W35: {}, W21: {}, W25: {},
  W29: { gone: 'going elsewhere' },
  W50: { gone: 'not in service' },
  W11: { until: '2026-09-30' },
  W32: { until: '2026-10-10' },
  W34: { until: '2026-10-02' },
};

const sortT = (xs: readonly string[]) => [...xs].sort();
const minusMinute = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const total = h * 60 + m - 1;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** The therapists the matcher will allow: allowed (or all) minus excluded, then the clinic's prenatal rule. */
function effectiveTherapists(r: Reading): Therapist[] {
  let set = (r.therapistsAllowed.value ?? [...THERAPISTS]).filter((x) => !r.therapistsExcluded.value.includes(x));
  if (r.prenatal.value) set = set.filter((x) => x === T.A || x === T.K);
  return set;
}

async function savedEntries() {
  return new FileReadingCache(READINGS).all();
}

describe('data/sample/readings.json', () => {
  it('has exactly one saved entry for each of the 45 groups, keyed by readingKey', async () => {
    const all = await savedEntries();
    expect(groups).toHaveLength(45);
    expect(Object.keys(all)).toHaveLength(45);
    for (const g of groups) {
      const e = all[readingKey(g, 2026)];
      expect(e, newest(g)).toBeDefined();
      expect(e!.by).toBe('saved');
      expect(e!.problems).toEqual([]);
    }
  });

  it('is written with sorted keys', () => {
    const keys = Object.keys(JSON.parse(fs.readFileSync(READINGS, 'utf8')) as object);
    expect(keys).toEqual([...keys].sort());
  });

  it('every entry passes validateReading with zero problems and comes back unchanged', async () => {
    const all = await savedEntries();
    for (const g of groups) {
      const e = all[readingKey(g, 2026)]!;
      const { reading, problems } = validateReading(e.reading, g);
      expect(problems, newest(g)).toEqual([]);
      expect(reading, newest(g)).toEqual(e.reading);
    }
  });

  it('holds no names, phones or health words', () => {
    const text = fs.readFileSync(READINGS, 'utf8');
    for (const l of lines) {
      expect(text).not.toContain(l.name);
      if (l.phoneDigits) expect(text).not.toContain(l.phoneDigits);
    }
    const quotes = [...text.matchAll(/"text": "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(quotes.length).toBeGreaterThan(50);
    for (const q of quotes) expect(hasHealthWord(q), q).toBe(false);
  });

  it('active people: every value matches rules-check P', async () => {
    const all = await savedEntries();
    const active = groups.filter((g) => P[newest(g)]);
    expect(active).toHaveLength(30);
    for (const g of active) {
      const id = newest(g);
      const p = P[id]!;
      const r = all[readingKey(g, 2026)]!.reading;
      const got = {
        ther: sortT(effectiveTherapists(r)),
        len: [...r.lengths.value.minutes].sort((a, b) => a - b),
        only: r.lengths.value.only,
        days: r.daysAllowed.value ? sortT(r.daysAllowed.value) : null,
        notDays: sortT(r.daysExcluded.value),
        startEarliest: r.startEarliest.value,
        startLatest: r.startLatest.value,
        endBy: r.endBy.value,
        notice: r.noticeHours.value,
        nextDay: r.nextDayOnly.value,
        from: r.availableFrom.value,
        until: r.availableUntil.value,
        prenatal: r.prenatal.value,
        gone: r.gone.value,
        unclear: r.unclear,
      };
      const want = {
        ther: sortT(p.ther),
        len: [...p.len].sort((a, b) => a - b),
        only: p.only ?? false,
        days: p.days ? sortT(p.days) : null,
        notDays: sortT(p.notDays ?? []),
        startEarliest: p.after ?? null,
        startLatest: p.startBy ?? (p.before ? minusMinute(p.before) : null),
        endBy: p.endBy ?? null,
        notice: p.notice ?? 2,
        nextDay: p.nextDay ?? false,
        from: p.from ?? null,
        until: null,
        prenatal: PREGNANT.has(id),
        gone: null,
        unclear: [],
      };
      expect(got, id).toEqual(want);
    }
  });

  it('pregnant people: the flag is kept, the therapist field is what the note says (prenatal rule applies later)', async () => {
    const all = await savedEntries();
    const byId = (id: string) => all[readingKey(groups.find((g) => newest(g) === id)!, 2026)]!.reading;
    expect(byId('W10').therapistsAllowed.value).toEqual(FEM); // "female"
    expect(byId('W40').therapistsAllowed.value).toBeNull(); // "Amira pref" is a preference only
    for (const id of ['W10', 'W40']) expect(byId(id).prenatal.source).toEqual([{ lineId: id, text: '' }]);
  });

  it('stale people: gone and end dates as the answer key needs', async () => {
    const all = await savedEntries();
    const stale = groups.filter((g) => !P[newest(g)]);
    expect(stale.map(newest).sort()).toEqual(Object.keys(STALE).sort());
    for (const g of stale) {
      const id = newest(g);
      const r = all[readingKey(g, 2026)]!.reading;
      expect(r.gone.value, id).toBe(STALE[id]!.gone ?? null);
      expect(r.availableUntil.value, id).toBe(STALE[id]!.until ?? null);
      if (r.gone.value) expect(r.gone.source.length, id).toBeGreaterThan(0);
      if (r.availableUntil.value) expect(r.availableUntil.source.length, id).toBeGreaterThan(0);
    }
  });
});

describe('Feature 1 gate with the saved readings (no Claude client)', () => {
  it('readAll serves all 45 from the file, and buildPeople gives 60/60 line verdicts', async () => {
    const results = await readAll(groups, { cache: new FileReadingCache(READINGS), client: null, runYear: 2026 });
    expect([...results.values()].every((r) => r.status === 'cached')).toBe(true);

    const result = buildPeople(lines, {
      runDate: '2026-10-21',
      appointments: parseAppointments(sample('appointments-2026-09-21-to-2026-10-17.csv')),
      getReading: makeGetReading(results, groups),
    });
    const key = parseCsv(sample('answer-key-tanya.csv')).filter((r) => r.type === 'waitlist line');
    expect(key).toHaveLength(60);
    const wrong = key
      .filter((k) => result.verdicts[k.id!] !== k.answer)
      .map((k) => `${k.id}: ours=${result.verdicts[k.id!]} key=${k.answer}`);
    expect(wrong).toEqual([]);
    expect(result.people.filter((p) => p.tags.length === 0).map((p) => p.key).sort()).toEqual(Object.keys(P).sort());
  });
});
