// One small function per rule check (build-plan.md "One rule, one function"). Each takes the same context and
// returns a CheckResult whose `reason` is plain words: no health details, no note text.
// Rule source for every check: rules.md Steps 2-3 (detail in build-plan.md section 5.4).
// Settings only change the three "Still to decide" items; nothing here is guessed.
import type { CheckResult, Opening, Person, Reading, Settings } from '@/lib/types';

export interface CheckContext {
  opening: Opening;
  person: Person;
  /** The person's note reading; null when the notes have not been read. */
  reading: Reading | null;
  settings: Settings;
}

export type Check = (ctx: CheckContext) => CheckResult;

// ---- helpers --------------------------------------------------------------------------------------

const ok = (check: string, reason: string): CheckResult => ({ check, pass: true, reason });
const no = (check: string, reason: string): CheckResult => ({ check, pass: false, reason });
const NOT_READ = 'Notes not read yet.';

/** "HH:MM" to minutes since midnight. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Milliseconds for a date and a time, all read as one local clock (no time zones). */
function stamp(date: string, hhmm: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
}

function cancelledStamp(cancelledAt: string): number {
  const [date = '', time = '00:00'] = cancelledAt.trim().split(/\s+/);
  return stamp(date, time);
}

/** Time the desk is free to start calling (builder-notes: check-ins and payments end about 10:30). */
export const DESK_FREE_TIME = '10:30';

/**
 * Hours of notice for this opening. 'cancelled' (default, matches Tanya's key): the opening's own
 * hours_notice. 'desk_free': counted from 10:30 on the opening date, or from the cancellation if that came later.
 */
export function noticeHoursFor(opening: Opening, settings: Settings): number {
  if (settings.noticeFrom === 'cancelled') return opening.hours_notice;
  const cancelled = cancelledStamp(opening.cancelled_at);
  const free = stamp(opening.date, DESK_FREE_TIME);
  const from = cancelled < free ? free : cancelled;
  return (stamp(opening.date, opening.start) - from) / 3_600_000;
}

const EPS = 1e-9;
const hoursText = (n: number): string => String(Math.round(n * 100) / 100);

// ---- checks ---------------------------------------------------------------------------------------

/** rules.md Step 3, first bullet: "Not a no-show. A no-show opening always gets nobody." */
export function noShow({ opening }: CheckContext): CheckResult {
  return opening.kind === 'no-show'
    ? no('noShow', 'No-show: there is no time to offer it.')
    : ok('noShow', 'A late cancellation, so it can be offered.');
}

/** rules.md Step 2: anyone tagged stale or booked is never offered. The reason is the tag's own reason. */
export function notTagged({ person }: CheckContext): CheckResult {
  const tag = person.tags[0];
  if (!tag) return ok('notTagged', 'Active on the waitlist.');
  return no('notTagged', `Not on the active list: ${tag.reason}`);
}

/** rules.md Step 1 and "Nothing unclear": a person whose notes were not read cannot be judged, so is not offered. */
export function hasReading({ reading }: CheckContext): CheckResult {
  return reading ? ok('hasReading', 'Notes read.') : no('hasReading', NOT_READ);
}

/** rules.md Step 3, "Therapist": the opening's therapist is one they will see (null = any) and not one they ruled out. */
export function therapist({ opening, reading }: CheckContext): CheckResult {
  if (!reading) return no('therapist', NOT_READ);
  const t = opening.therapist;
  if (reading.therapistsExcluded.value.includes(t)) return no('therapist', `Will not see ${t}.`);
  const allowed = reading.therapistsAllowed.value;
  if (allowed !== null && !allowed.includes(t)) return no('therapist', `Does not see ${t}.`);
  return ok('therapist', `Will see ${t}.`);
}

/**
 * rules.md Step 3, "Pregnancy rule": Amira or Kelsey only, whatever the person said. Named "clinicRule" in every
 * trace, and the pass reason is the same for everyone, so a trace never shows who the rule applies to.
 */
export function clinicRule({ opening, reading }: CheckContext): CheckResult {
  if (!reading) return no('clinicRule', NOT_READ);
  const t = opening.therapist;
  if (!reading.prenatal.value || t === 'Amira Haddad' || t === 'Kelsey Babineau') return ok('clinicRule', 'Clinic rules met.');
  return no('clinicRule', `Clinic rule: only Amira Haddad or Kelsey Babineau, not ${t}.`);
}

/**
 * rules.md Step 3, "Length": the opening is a length they want; "90" means 90 only. Setting allowLongerOpening
 * ("Still to decide" 2, default true): an opening longer than the shortest they asked for is also OK.
 */
export function length({ opening, reading, settings }: CheckContext): CheckResult {
  if (!reading) return no('length', NOT_READ);
  const { minutes, only } = reading.lengths.value;
  const len = opening.length_min;
  if (minutes.includes(len)) return ok('length', `${len} minutes is a length they want.`);
  if (!only && settings.allowLongerOpening && minutes.length > 0 && len >= Math.min(...minutes)) {
    return ok('length', `${len} minutes is longer than the ${Math.min(...minutes)} they asked for.`);
  }
  return no('length', `${len} minutes is not a length they want (${minutes.join(' or ')}${only ? ' only' : ''}).`);
}

/** rules.md Step 3, "Day": a day they can do (null = any), and not one they have ruled out. */
export function day({ opening, reading }: CheckContext): CheckResult {
  if (!reading) return no('day', NOT_READ);
  if (reading.daysExcluded.value.includes(opening.day)) return no('day', `Cannot do ${opening.day}.`);
  const allowed = reading.daysAllowed.value;
  if (allowed !== null && !allowed.includes(opening.day)) return no('day', `Does not do ${opening.day}.`);
  return ok('day', `Can do ${opening.day}.`);
}

/**
 * rules.md Step 3, "Time": the start falls within the hours they can do ("HH:MM", inclusive); "done by 2:30"
 * means start + length must be 14:30 or earlier.
 */
export function time({ opening, reading }: CheckContext): CheckResult {
  if (!reading) return no('time', NOT_READ);
  const start = toMinutes(opening.start);
  const earliest = reading.startEarliest.value;
  const latest = reading.startLatest.value;
  const endBy = reading.endBy.value;
  if (earliest !== null && start < toMinutes(earliest)) return no('time', `Starts too early (they can start from ${earliest}).`);
  if (latest !== null && start > toMinutes(latest)) return no('time', `Starts too late (they can start by ${latest}).`);
  if (endBy !== null && start + opening.length_min > toMinutes(endBy)) return no('time', `Ends too late (they need to be done by ${endBy}).`);
  return ok('time', `${opening.start} fits their hours.`);
}

/**
 * rules.md Step 3, "Notice": the time from the cancellation to the start is at least what they need.
 * Settings: noticeFrom ("Still to decide" 1) and noticeEqualIsEnough ("Still to decide" 3).
 */
export function notice({ opening, reading, settings }: CheckContext): CheckResult {
  if (!reading) return no('notice', NOT_READ);
  const have = noticeHoursFor(opening, settings);
  const need = reading.noticeHours.value;
  const pass = settings.noticeEqualIsEnough ? have >= need - EPS : have > need + EPS;
  return pass
    ? ok('notice', `${hoursText(have)} hours of notice; they need ${hoursText(need)}.`)
    : no('notice', `Only ${hoursText(have)} hours of notice; they need ${hoursText(need)}.`);
}

/** rules.md Step 3, "Notice": "The day before" means the cancellation came on an earlier calendar day. */
export function nextDay({ opening, reading }: CheckContext): CheckResult {
  if (!reading) return no('nextDay', NOT_READ);
  if (!reading.nextDayOnly.value) return ok('nextDay', 'No day-before requirement.');
  const cancelledDate = opening.cancelled_at.trim().slice(0, 10);
  return cancelledDate < opening.date
    ? ok('nextDay', 'Cancelled on an earlier day, as they need.')
    : no('nextDay', 'Cancelled the same day; they need to be told the day before.');
}

/** rules.md Step 3, "Dates": they are back by the opening date, and it is not past their "only until" date. */
export function dates({ opening, reading }: CheckContext): CheckResult {
  if (!reading) return no('dates', NOT_READ);
  const from = reading.availableFrom.value;
  const until = reading.availableUntil.value;
  if (from !== null && from > opening.date) return no('dates', `Not back until ${from}.`);
  if (until !== null && until < opening.date) return no('dates', `Only available until ${until}.`);
  return ok('dates', 'Available on this date.');
}

/**
 * rules.md Step 3, "Nothing unclear": any unclear part of the notes fails the person, because each topic
 * could change one of the checks above. The reason names topics only, never the note text.
 */
export function unclear({ reading }: CheckContext): CheckResult {
  if (!reading) return no('unclear', NOT_READ);
  if (reading.unclear.length === 0) return ok('unclear', 'Nothing unclear in the notes.');
  const topics = [...new Set(reading.unclear.flatMap((u) => u.affects))];
  return no('unclear', `Notes unclear about ${topics.length ? topics.join(', ') : 'something'}.`);
}
