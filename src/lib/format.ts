// Plain-words text for what the notes say (B5 "What the notes say"). Pure functions, no I/O.
// Only validated quotes are ever shown (rules.md "Always": never notes or health details). The pregnancy rule
// shows as "clinic rule · wording hidden" and never with any words from the notes.
import { CLINIC_TIME_ZONE } from '@/lib/clinic';
import { DAYS, THERAPISTS } from '@/lib/types';
import type { Day, Quote, Reading, Therapist } from '@/lib/types';

export const DEFAULT_SOURCE = 'none written: default';
export const CLINIC_RULE_SOURCE = 'clinic rule · wording hidden';
const CLINIC_RULE_THERAPISTS: Therapist[] = ['Amira Haddad', 'Kelsey Babineau'];
const FEMALE: Therapist[] = ['Amira Haddad', 'Josée Landry', 'Kelsey Babineau', 'Rachel Thibodeau'];
const WEEKDAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ["a"] -> "a"; ["a","b"] -> "a or b"; ["a","b","c"] -> "a, b or c". */
export function joinOr(items: string[], word = 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
}

const firstName = (t: Therapist): string => t.split(' ')[0]!;
const capitalise = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const sameSet = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x) => b.includes(x));
const byDayOrder = (days: Day[]) => [...days].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));

/** "15:30" -> "3:30 PM", "12:00" -> "12:00 PM", "09:05" -> "9:05 AM". */
export function clockText(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** "2026-10-10" -> "Oct 10". */
export function monthDay(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[1]) - 1] ?? m[1]} ${Number(m[2])}`;
}

/** "2026-10-17" -> "Sat, Oct 17, 2026". */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${day}, ${monthDay(iso)}, ${m[1]}`;
}

/** Today's date as YYYY-MM-DD in the clinic's time zone (CLINIC_TIME_ZONE, default New Brunswick). */
export function todayIso(now: Date = new Date(), timeZone = CLINIC_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** ISO timestamp -> "Oct 29, 2:07 PM" in the clinic's time zone (same text on the server and in the browser). */
export function timestampText(iso: string, timeZone = CLINIC_TIME_ZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hhmm = `${String(get('hour') % 24).padStart(2, '0')}:${String(get('minute')).padStart(2, '0')}`;
  return `${MONTHS[get('month') - 1]} ${get('day')}, ${clockText(hhmm)}`;
}

/** Therapists the person can see, in the order the notes give them (null = any). */
function allowedTherapists(r: Reading): Therapist[] | null {
  const excluded = r.therapistsExcluded.value;
  if (r.therapistsAllowed.value === null) return excluded.length === 0 ? null : THERAPISTS.filter((t) => !excluded.includes(t));
  return r.therapistsAllowed.value.filter((t) => !excluded.includes(t));
}

/** "Anyone but Dave", "Rachel or Josée", "Any therapist"; the clinic rule gives "Amira or Kelsey". */
export function therapistText(r: Reading): string {
  if (r.prenatal.value) {
    const allowed = allowedTherapists(r) ?? [...THERAPISTS];
    const fits = CLINIC_RULE_THERAPISTS.filter((t) => allowed.includes(t));
    return fits.length === 0 ? 'No therapist fits' : joinOr(fits.map(firstName));
  }
  if (r.therapistsAllowed.value === null) {
    const excluded = r.therapistsExcluded.value;
    return excluded.length === 0 ? 'Any therapist' : `Anyone but ${joinOr(excluded.map(firstName))}`;
  }
  const allowed = allowedTherapists(r)!;
  if (allowed.length === 0) return 'No therapist fits';
  if (sameSet(allowed, FEMALE)) return 'Any female therapist';
  if (sameSet(allowed, [...THERAPISTS])) return 'Any therapist';
  return joinOr(allowed.map(firstName));
}

/** "60 min", "60 or 90 min", "90 min only". */
export function lengthText(r: Reading): string {
  const minutes = [...r.lengths.value.minutes].sort((a, b) => a - b);
  const text = `${joinOr(minutes.map(String))} min`;
  return r.lengths.value.only ? `${text} only` : text;
}

function daysPart(r: Reading): string | null {
  const excluded = r.daysExcluded.value;
  if (r.daysAllowed.value === null) return excluded.length === 0 ? null : `not ${joinOr(byDayOrder(excluded))}`;
  const days = byDayOrder(r.daysAllowed.value.filter((d) => !excluded.includes(d)));
  if (days.length === 0) return 'no day fits';
  if (sameSet(days, WEEKDAYS)) return 'weekdays';
  if (sameSet(days, ['Sat', 'Sun'])) return 'weekends';
  if (days.length === 1) return `${days[0]} only`;
  return joinOr(days);
}

function timesPart(r: Reading): string[] {
  const early = r.startEarliest.value;
  const late = r.startLatest.value;
  const parts: string[] = [];
  if (early === '12:00' && late === null) parts.push('afternoons (start 12:00 or later)');
  else if (early === null && late === '11:59') parts.push('mornings');
  else if (early !== null && late !== null) parts.push(`start ${clockText(early)} to ${clockText(late)}`);
  else if (early !== null) parts.push(`start ${clockText(early)} or later`);
  else if (late !== null) parts.push(`start by ${clockText(late)}`);
  if (r.endBy.value !== null) parts.push(`done by ${clockText(r.endBy.value)}`);
  return parts;
}

/** "Not Thu · start 3:30 PM or later", "Not Sat · from Oct 10", "Any day, any time". */
export function availabilityText(r: Reading): string {
  const parts: string[] = [];
  const days = daysPart(r);
  if (days) parts.push(days);
  parts.push(...timesPart(r));
  if (r.availableFrom.value) parts.push(`from ${monthDay(r.availableFrom.value)}`);
  if (r.availableUntil.value) parts.push(`until ${monthDay(r.availableUntil.value)}`);
  return parts.length === 0 ? 'Any day, any time' : capitalise(parts.join(' · '));
}

/** 2 -> "2 h", 0.5 -> "30 min", 1.5 -> "1 h 30 min". */
export function hoursText(hours: number): string {
  const total = Math.round(hours * 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "2 h", "30 min", "The day before". */
export function noticeText(r: Reading): string {
  return r.nextDayOnly.value ? 'The day before' : hoursText(r.noticeHours.value);
}

export interface SourceOptions {
  /** The person's newest line. A quote from an older line gets "(W26)" after it. */
  newestId: string;
  /** Adds " (higher number)" after a quote with a range ("2-3 hrs") whose higher end is this value. */
  higherOf?: number;
}

/** `"anyone but Dave"`, `"1hr" (W26)`, `"not Mon", "AM"`; nothing written gives "none written: default". */
export function sourceText(quotes: Quote[], opts: SourceOptions): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of quotes) {
    const text = q.text.trim();
    if (text === '') continue;
    const key = `${q.lineId}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let s = `"${text}"`;
    if (q.lineId !== opts.newestId) s += ` (${q.lineId})`;
    if (opts.higherOf !== undefined) {
      const range = /(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/.exec(text);
      if (range && Number(range[2]) === opts.higherOf && Number(range[1]) < opts.higherOf) s += ' (higher number)';
    }
    out.push(s);
  }
  return out.length === 0 ? DEFAULT_SOURCE : out.join(', ');
}

export interface Cell {
  value: string;
  source: string;
}

export interface ReadingCells {
  therapist: Cell;
  length: Cell;
  availability: Cell;
  notice: Cell;
}

/** The four B5 columns for one person. */
export function readingCells(r: Reading, newestId: string): ReadingCells {
  const src = (quotes: Quote[], higherOf?: number) => sourceText(quotes, { newestId, higherOf });
  return {
    therapist: {
      value: therapistText(r),
      source: r.prenatal.value ? CLINIC_RULE_SOURCE : src([...r.therapistsAllowed.source, ...r.therapistsExcluded.source]),
    },
    length: { value: lengthText(r), source: src(r.lengths.source) },
    availability: {
      value: availabilityText(r),
      source: src([
        ...r.daysAllowed.source,
        ...r.daysExcluded.source,
        ...r.startEarliest.source,
        ...r.startLatest.source,
        ...r.endBy.source,
        ...r.availableFrom.source,
        ...r.availableUntil.source,
      ]),
    },
    notice: r.nextDayOnly.value
      ? { value: noticeText(r), source: src(r.nextDayOnly.source) }
      : { value: noticeText(r), source: src(r.noticeHours.source, r.noticeHours.value) },
  };
}

const TOPIC_WORDS: Record<string, string> = {
  therapist: 'therapist',
  length: 'length',
  day: 'days',
  time: 'times',
  notice: 'notice',
  dates: 'dates',
};

/** "Notes unclear about times and notice, so not offered." Never the unclear words themselves. */
export function unclearText(topics: string[]): string {
  const words = [...new Set(topics.map((t) => TOPIC_WORDS[t] ?? t))];
  return `Notes unclear about ${joinOr(words, 'and') || 'something'}, so not offered.`;
}
