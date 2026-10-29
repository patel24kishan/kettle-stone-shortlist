// Builds data/sample/readings.json: the saved readings for the sample waitlist, so the sample runs offline
// with no Claude key. Values for the 30 active people follow reference/rules-check.mjs `P` (which reproduces
// Tanya's answer key); stale people get their gone / end-date readings and plain readings of the rest.
// Every reading goes through validateReading and must come out with zero problems.
//
//   npx tsx scripts/build-sample-readings.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWaitlist } from '../src/lib/csv';
import { groupLines } from '../src/lib/import';
import type { Day, Field, Quote, Reading, Therapist } from '../src/lib/types';
import { defaultReading } from '../src/lib/readings/schema';
import { validateReading } from '../src/lib/readings/validate';
import { readingKey } from '../src/lib/readings/hash';
import { FileReadingCache } from '../src/lib/readings/cache';

const RUN_YEAR = 2026;
const READ_AT = '2026-10-29T00:00:00.000Z'; // fixed, so regenerating gives the same file
const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, '..', 'data', 'sample');
const OUT = path.join(SAMPLE, 'readings.json');

const A: Therapist = 'Amira Haddad';
const D: Therapist = 'Dave Melanson';
const J: Therapist = 'Josée Landry';
const K: Therapist = 'Kelsey Babineau';
const M: Therapist = 'Marc Cormier';
const R: Therapist = 'Rachel Thibodeau';
const FEMALE: Therapist[] = [J, A, K, R];
const WEEKDAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const q = (lineId: string, text: string): Quote => ({ lineId, text });
const v = <T>(value: T, ...source: Quote[]): Field<T> => ({ value, source });
const len = (minutes: number[], only: boolean, ...source: Quote[]) => v({ minutes, only }, ...source);

type Spec = Partial<Reading>;

/** Keyed by each person's newest line id. */
const SPECS: Record<string, Spec> = {
  // ---- active (rules-check P) ----
  W10: {
    therapistsAllowed: v(FEMALE, q('W10', 'female')),
    lengths: len([60], false, q('W10', '60')),
    daysAllowed: v(WEEKDAYS, q('W10', 'wkdays')),
    prenatal: v(true, q('W10', '')),
  },
  W12: {
    therapistsExcluded: v([D], q('W12', 'anyone but Dave')),
    lengths: len([60], false, q('W12', '1hr')),
    daysExcluded: v<Day[]>(['Thu'], q('W12', 'not Thurs')),
    startEarliest: v('15:30', q('W12', 'after 3:30')),
  },
  W14: {
    therapistsAllowed: v([J], q('W14', 'Josée only')),
    lengths: len([45, 60], false, q('W14', '45 or 60')),
    noticeHours: v(3, q('W14', 'needs 3h')),
  },
  W18: {
    therapistsAllowed: v([M], q('W18', 'Marc only')),
    startLatest: v('11:59', q('W18', 'AM')),
    noticeHours: v(0.5, q('W18', 'can come in 30 min')),
  },
  W20: {
    therapistsAllowed: v(FEMALE, q('W20', 'female only')),
    lengths: len([60], false, q('W20', '60')),
    daysAllowed: v<Day[]>(['Tue', 'Thu'], q('W20', 'Tues/Thurs')),
  },
  W24: {
    therapistsAllowed: v(null, q('W24', 'any')),
    startEarliest: v('17:00', q('W24', 'after 5')),
  },
  W28: {
    therapistsAllowed: v(null, q('W28', 'any')),
    lengths: len([90], true, q('W28', '90 only')),
    daysAllowed: v<Day[]>(['Sat'], q('W28', 'Sat')),
  },
  W33: {
    therapistsExcluded: v([D], q('W33', 'AB Dave')),
    lengths: len([60], false, q('W33', '1hr')),
    daysExcluded: v<Day[]>(['Mon'], q('W33', 'not Mon')),
    startLatest: v('11:59', q('W33', 'AM')),
  },
  W36: {
    therapistsAllowed: v([A], q('W36', 'Amira only')),
    lengths: len([45], false, q('W36', '45')),
    startEarliest: v('10:00', q('W36', 'not before 10')),
  },
  W37: {
    therapistsAllowed: v(null, q('W37', 'any')),
    daysAllowed: v<Day[]>(['Fri'], q('W37', 'Fri only')),
    startEarliest: v('15:00', q('W37', 'after 3')),
  },
  W38: {
    therapistsAllowed: v([R], q('W38', 'Rachel only')),
    lengths: len([60], false, q('W38', '1hr')),
    startEarliest: v('18:00', q('W38', 'evenings after 6')),
  },
  W39: {
    therapistsAllowed: v(null, q('W39', 'any')),
    lengths: len([30, 45], false, q('W39', '30 or 45')),
    daysAllowed: v(WEEKDAYS, q('W39', 'on his lunch')),
    startEarliest: v('12:00', q('W39', 'on his lunch 12-1 only')),
    startLatest: v('12:30', q('W39', 'on his lunch 12-1 only')),
    noticeHours: v(0.5, q('W39', '30 min notice ok')),
  },
  W40: {
    // "Amira pref" is a preference only (5.1): therapistsAllowed stays any. The prenatal rule limits it.
    prenatal: v(true, q('W40', '')),
    noticeHours: v(3, q('W40', 'needs 2-3 hrs')),
  },
  W42: {
    therapistsAllowed: v([R, J], q('W42', 'R/J'), q('W26', 'Rachel or Josée')),
    lengths: len([60], false, q('W26', '1hr')),
  },
  W43: {
    therapistsAllowed: v([K, A], q('W30', 'Kelsey or Amira')),
    lengths: len([60], false, q('W30', '1hr')),
    endBy: v('14:30', q('W43', 'has to be done by 2:30')),
  },
  W45: {
    therapistsAllowed: v([J, A], q('W45', 'Josée or Amira')),
    lengths: len([60], false, q('W45', '60')),
    daysExcluded: v<Day[]>(['Fri'], q('W45', 'not Fri')),
  },
  W46: {
    therapistsAllowed: v([M, D], q('W46', 'Marc or Dave')),
    lengths: len([60], false, q('W46', '1hr')),
  },
  W47: {
    therapistsAllowed: v([D], q('W47', 'Dave'), q('W04', 'Dave only')),
    lengths: len([60, 90], false, q('W47', '90 or 60 fine')),
    startEarliest: v('16:00', q('W47', 'after 4')),
  },
  W48: {
    therapistsAllowed: v([J, R], q('W48', 'Jos or Rachel ok now')),
    lengths: len([60], false, q('W16', '60')),
    startLatest: v('11:59', q('W48', 'AM only')),
  },
  W49: {
    therapistsAllowed: v(FEMALE, q('W49', 'any female')),
    lengths: len([45], false, q('W49', '45')),
    daysAllowed: v<Day[]>(['Wed', 'Fri'], q('W49', 'Wed or Fri')),
    noticeHours: v(4, q('W49', 'needs 4 hrs')),
  },
  W51: {
    therapistsAllowed: v(null, q('W02', 'any')),
    lengths: len([60], false, q('W02', '1hr')),
    daysAllowed: v<Day[]>(['Mon', 'Wed'], q('W51', 'Mon or Wed AM only now')),
    startLatest: v('11:59', q('W51', 'AM only now')),
  },
  W52: {
    therapistsAllowed: v([K, J], q('W52', 'Kelsey or Josée')),
    lengths: len([60], false, q('W52', '60')),
    daysAllowed: v<Day[]>(['Wed', 'Fri'], q('W52', 'Wed/Fri')),
  },
  W53: {
    therapistsAllowed: v(null, q('W22', 'any')),
    lengths: len([60, 90], false, q('W53', 'wants 90 if poss, 60 ok')),
    daysExcluded: v<Day[]>(['Sat'], q('W53', 'not Sat')),
    // "back now" on Oct 9 and "away hunting til Oct 9" both give Oct 10. "back" is never quoted.
    availableFrom: v('2026-10-10', q('W22', 'away hunting til Oct 9'), q('W53', 'now')),
  },
  W54: {
    therapistsExcluded: v([D], q('W54', 'any but Dave')),
    lengths: len([90], true, q('W54', '90')),
    startEarliest: v('16:00', q('W54', 'after 4')),
  },
  W55: {
    therapistsAllowed: v([R, A], q('W55', 'Rachel or Amira')),
    lengths: len([60], false, q('W27', '60')),
    nextDayOnly: v(true, q('W27', 'next day only')),
  },
  W56: {
    therapistsAllowed: v([A], q('W56', 'still Amira'), q('W06', 'Amira')),
    lengths: len([60], false, q('W06', '1hr')),
    daysAllowed: v<Day[]>(['Mon', 'Tue'], q('W56', 'Mon or Tues')),
  },
  W57: {
    therapistsAllowed: v([D, J], q('W57', 'Dave or Jos')),
    startEarliest: v('12:00', q('W57', 'afternoons')),
    noticeHours: v(2, q('W57', 'can come in 2 hrs')),
  },
  W58: {
    therapistsAllowed: v([D], q('W58', 'Dave'), q('W41', 'Dave only')),
    lengths: len([90], true, q('W58', '90'), q('W41', '90')),
    daysAllowed: v<Day[]>(['Tue', 'Fri'], q('W58', 'Tues or Fri only now')),
  },
  W59: {
    therapistsAllowed: v(null, q('W59', 'any')),
    lengths: len([45], false, q('W59', '45')),
    daysAllowed: v<Day[]>(['Mon', 'Tue'], q('W59', 'Mon/Tues')),
    startEarliest: v('17:00', q('W59', 'after 5')),
    noticeHours: v(1, q('W59', 'can come in an hour')),
  },
  W60: {
    therapistsAllowed: v(null, q('W44', 'any')),
    lengths: len([60], false, q('W44', '60')),
    daysExcluded: v<Day[]>(['Thu'], q('W60', 'not Thurs')),
    startLatest: v('11:59', q('W44', 'AM')),
  },

  // ---- stale (tagged by Feature 1; readings kept for B5) ----
  W01: {
    therapistsAllowed: v(null, q('W01', 'any')),
    lengths: len([90], true, q('W01', '90')),
  },
  W03: {
    therapistsAllowed: v([D], q('W03', 'Dave only')),
    startEarliest: v('17:00', q('W03', 'after 5')),
  },
  W07: {
    therapistsAllowed: v([J], q('W05', 'J only')),
    lengths: len([45, 60], false, q('W07', '45 or 60')),
  },
  W08: {
    therapistsAllowed: v(null, q('W08', 'any')),
    lengths: len([30], false, q('W08', '30')),
    unclear: [{ lineId: 'W08', text: 'lunch', affects: ['time'] }],
  },
  W31: {
    therapistsAllowed: v([J, R], q('W09', 'Josée or Rachel')),
    lengths: len([60, 90], false, q('W09', '90'), q('W31', '60 ok too')),
  },
  W11: {
    therapistsAllowed: v(null, q('W11', 'any')),
    lengths: len([60], false, q('W11', '60')),
    availableUntil: v('2026-09-30', q('W11', 'only til end of Sept')),
  },
  W50: {
    therapistsAllowed: v(FEMALE, q('W13', 'female only')),
    lengths: len([60], false, q('W13', '60')),
    startEarliest: v('16:00', q('W13', 'after 4')),
    gone: v<Reading['gone']['value']>('not in service', q('W50', '# not in service')),
  },
  W15: {
    therapistsAllowed: v(null, q('W15', 'any')),
    lengths: len([60], false, q('W15', '60')),
  },
  W34: {
    therapistsAllowed: v(FEMALE, q('W17', 'any female')),
    lengths: len([90], true, q('W17', '90')),
    availableUntil: v('2026-10-02', q('W17', 'before wedding Oct 3')),
  },
  W35: {
    therapistsAllowed: v(null, q('W19', 'any')),
    lengths: len([60], false, q('W19', '60')),
    startLatest: v('11:59', q('W35', 'mornings still')),
  },
  W21: {
    therapistsExcluded: v([M], q('W21', 'not Marc')),
    lengths: len([60], false, q('W21', '1hr')),
    unclear: [{ lineId: 'W21', text: 'can come quick', affects: ['notice'] }],
  },
  W23: {
    therapistsAllowed: v(null, q('W23', 'any')),
    lengths: len([60], false, q('W23', '60')),
    daysAllowed: v<Day[]>(['Sat'], q('W23', 'Sat only')),
    gone: v<Reading['gone']['value']>('moved', q('W23', 'moved to Hfx')),
  },
  W25: {
    therapistsAllowed: v([K], q('W25', 'Kelsey only')),
    lengths: len([60], false, q('W25', '1hr')),
    daysAllowed: v<Day[]>(['Tue'], q('W25', 'Tues')),
  },
  W29: {
    therapistsAllowed: v([A], q('W29', 'Amira')),
    lengths: len([45], false, q('W29', '45')),
    gone: v<Reading['gone']['value']>('going elsewhere', q('W29', 'going to someone in Dieppe now, take off')),
  },
  W32: {
    therapistsAllowed: v(null, q('W32', 'any')),
    startEarliest: v('16:00', q('W32', 'after 4')),
    availableUntil: v('2026-10-10', q('W32', 'here til Oct 10')),
  },
};

async function main() {
  const lines = parseWaitlist(fs.readFileSync(path.join(SAMPLE, 'waitlist-2026-10-21.csv'), 'utf8'), RUN_YEAR);
  const groups = groupLines(lines);
  const unused = new Set(Object.keys(SPECS));
  const failures: string[] = [];

  const entries: { key: string; reading: Reading }[] = [];
  for (const group of groups) {
    const id = group[group.length - 1]!.id;
    const spec = SPECS[id];
    if (!spec) {
      failures.push(`${id}: no saved reading written for this person.`);
      continue;
    }
    unused.delete(id);
    const raw: Reading = { ...defaultReading(), ...spec };
    const { reading, problems } = validateReading(raw, group);
    if (problems.length) failures.push(...problems.map((p) => `${id}: ${p}`));
    entries.push({ key: readingKey(group, RUN_YEAR), reading });
  }
  for (const id of unused) failures.push(`${id}: a saved reading has no matching person.`);

  if (failures.length) {
    console.error(`Not written; fix these first:\n${failures.join('\n')}`);
    process.exitCode = 1;
    return;
  }

  // Start from an empty file so keys from older lines or an older SCHEMA_VERSION do not linger.
  if (fs.existsSync(OUT)) fs.rmSync(OUT);
  const cache = new FileReadingCache(OUT);
  for (const { key, reading } of entries) {
    await cache.set(key, { reading, readAt: READ_AT, by: 'saved', problems: [] });
  }
  console.log(`Wrote ${groups.length} saved readings to ${path.relative(process.cwd(), OUT)}.`);
}

void main();
