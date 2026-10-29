// What the Search screen (A1b, with A1 / A2 / A2b) shows for one opening. Pure: no I/O, safe in client code.
// Mockups: reference/mockups/A1b-Search-one-or-all.dc.html (renderVals), Main.dc.html, A2-Nobody-fits.dc.html,
// A2b-Nobody-in-file.dc.html. build-plan section 6 Step 6, Screens 1 and 2, and "Screen rules".
// rules.md "Always": only name, phone, line number and the opening are shown; never notes or health details.
import { CLINIC_TIME_ZONE } from '@/lib/clinic';
import { clockText, hoursText, timestampText } from '@/lib/format';
import { THERAPISTS } from '@/lib/types';
import type { BookedRecord, Opening, OpeningResult, Therapist } from '@/lib/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const LENGTHS = [30, 45, 60, 90] as const;
export const DEFAULT_LENGTH = 60;
/** How many openings the file view shows before "Show N more" (A1b). */
export const PAGE_SIZE = 8;

export const NOBODY_HEAD = 'No one on the waitlist can take this opening.';
/** Same words as the matcher's NO_SHOW_REASON (kept here so client code doesn't pull in the matcher). */
export const NO_SHOW_HEAD = 'No-show: there is no time to offer it.';
export const NO_SHOW_WHY = 'We only know 15 minutes after the start, so the waitlist isn’t searched.';
export const SHORT_LINE = 'That’s everyone who fits. Nobody else on the waitlist can take this opening.';
export const BOOKED_FOOTER =
  "Tap Booked once they've said yes and it's booked in Kneadly. They won't be suggested again, for this or any other opening. A no or no answer changes nothing.";
export const JOSEE_NOTE = 'Josée wants to see who it is first.';

// ---- dates and times ------------------------------------------------------------------------------------

function isoParts(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isRealDate(iso: string): boolean {
  const p = isoParts(iso);
  if (!p) return false;
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

export function isClock(hhmm: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

/** "2026-10-15" -> "Thu". */
export function weekdayOf(iso: string): (typeof WEEKDAYS)[number] {
  const p = isoParts(iso);
  if (!p) return 'Sun';
  return WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()]!;
}

/** "2026-10-15" -> "Thu, Oct 15". */
export function shortDate(iso: string): string {
  const p = isoParts(iso);
  if (!p) return iso;
  return `${weekdayOf(iso)}, ${MONTHS[p[1] - 1]} ${p[2]}`;
}

/** The clinic's clock now, as a datetime-local value: "2026-10-29T14:07" (CLINIC_TIME_ZONE, default New Brunswick). */
export function clinicNowLocal(now: Date = new Date(), timeZone = CLINIC_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
}

/** "14:00" + 60 -> "15:00". Wraps at midnight. */
export function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = ((((h ?? 0) * 60 + (m ?? 0) + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** "2:00 to 3:00 PM" when both are in the same half of the day, else "11:00 AM to 12:00 PM". */
export function timeRange(start: string, lengthMin: number): string {
  const end = addMinutes(start, lengthMin);
  const a = clockText(start);
  const b = clockText(end);
  const half = (s: string) => s.slice(-2);
  return half(a) === half(b) ? `${a.slice(0, -3)} to ${b}` : `${a} to ${b}`;
}

/** "Dave Melanson · Thu, Oct 15 · 2:00 to 3:00 PM · 60 min". */
export function openingSummary(o: Pick<Opening, 'therapist' | 'date' | 'start' | 'length_min'>): string {
  return `${o.therapist} · ${shortDate(o.date)} · ${timeRange(o.start, o.length_min)} · ${o.length_min} min`;
}

/** "yyyy-mm-dd HH:MM" or "yyyy-mm-ddTHH:MM[:ss]" -> minutes since 1970 on one local clock, or null. */
function clockStamp(dateTime: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(dateTime.trim());
  if (!m) return null;
  if (!isRealDate(`${m[1]}-${m[2]}-${m[3]}`) || !isClock(`${m[4]}:${m[5]}`)) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) / 60_000;
}

/** Minutes from the cancellation to the start (both on the clinic's clock), or null when either can't be read. */
export function noticeMinutesBetween(cancelledAt: string, date: string, start: string): number | null {
  const from = clockStamp(cancelledAt);
  const to = clockStamp(`${date} ${start}`);
  if (from === null || to === null) return null;
  return to - from;
}

/** The opening's notice in minutes: from cancelled_at when readable, else from hours_notice. */
export function noticeMinutes(o: Pick<Opening, 'cancelled_at' | 'date' | 'start' | 'hours_notice'>): number {
  return noticeMinutesBetween(o.cancelled_at, o.date, o.start) ?? Math.round(o.hours_notice * 60);
}

/** 74 -> "1 h 14 min", 45 -> "45 min", 120 -> "2 h". */
export function noticeText(minutes: number): string {
  return hoursText(minutes / 60);
}

// ---- one opening from the form --------------------------------------------------------------------------

export interface OneOpeningInput {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24 h */
  start: string;
  therapist: string;
  length: number;
  /** When it was cancelled: "YYYY-MM-DDTHH:MM" (datetime-local) or "YYYY-MM-DD HH:MM". */
  cancelledAt: string;
}

const initials = (t: string) =>
  t
    .split(/\s+/)
    .map((w) => w.normalize('NFD').replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase())
    .join('');

/** "Q-20261015-1400-DM": one id per slot (date, start, therapist), so the slot can only be booked once. */
export function queryOpeningId(date: string, start: string, therapist: string): string {
  return `Q-${date.replace(/-/g, '')}-${start.replace(':', '')}-${initials(therapist)}`;
}

/** Problems with the form, in plain words (empty = fine). */
export function checkOneInput(input: Partial<OneOpeningInput>): string[] {
  const problems: string[] = [];
  const date = String(input.date ?? '');
  const start = String(input.start ?? '');
  if (!isRealDate(date)) problems.push('Choose the date of the opening.');
  if (!isClock(start)) problems.push('Choose the start time.');
  if (!(THERAPISTS as readonly string[]).includes(String(input.therapist ?? ''))) problems.push('Choose a therapist.');
  if (!(LENGTHS as readonly number[]).includes(Number(input.length))) problems.push('Choose a length: 30, 45, 60 or 90 min.');
  const cancelled = String(input.cancelledAt ?? '');
  if (clockStamp(cancelled) === null) {
    problems.push('Choose when it was cancelled.');
  } else if (problems.length === 0) {
    const minutes = noticeMinutesBetween(cancelled, date, start)!;
    if (minutes < 0) problems.push('The cancellation time is after the start. Check the date and times.');
  }
  return problems;
}

/** The late-cancel Opening the matcher checks. Call checkOneInput first. */
export function openingFromInput(input: OneOpeningInput, openingId?: string): Opening {
  const cancelled = input.cancelledAt.trim().replace('T', ' ').slice(0, 16);
  const minutes = noticeMinutesBetween(cancelled, input.date, input.start) ?? 0;
  return {
    opening_id: openingId ?? queryOpeningId(input.date, input.start, input.therapist),
    appointment_id: '',
    date: input.date,
    day: weekdayOf(input.date),
    start: input.start,
    length_min: Number(input.length),
    therapist: input.therapist as Therapist,
    kind: 'late cancel',
    cancelled_at: cancelled,
    hours_notice: minutes / 60,
    heard_via: '',
    client_had_confirmed: '',
    refilled: '',
    refilled_how: '',
    booked_value_cad: '',
  };
}

// ---- the display model ----------------------------------------------------------------------------------

export interface SearchCard {
  /** 1, 2, 3 down the list. */
  n: number;
  lineId: string;
  name: string;
  /** "(506) 555-0140" */
  phone: string;
  /** "tel:+15065550140" */
  tel: string;
}

export interface FilledView {
  lineId: string;
  name: string;
  /** ISO timestamp of the booking. */
  at: string;
  /** "Oct 29, 2:07 PM" (clinic time). */
  atText: string;
}

export interface OpeningView {
  id: string;
  date: string;
  start: string;
  therapist: Therapist;
  kind: Opening['kind'];
  /** "3 people fit", "2 people fit", "1 person fits", "Nobody fits"; "Filled" once booked. */
  fitLabel: string;
  /** "Dave Melanson · Thu, Oct 15 · 2:00 to 3:00 PM · 60 min" */
  summary: string;
  cards: SearchCard[];
  /** 1 or 2 names: show "That's everyone who fits." */
  short: boolean;
  nobody: { head: string; why: string } | null;
  joseeNote: boolean;
  /** Set when the opening already has a Booked record: shown instead of suggestions. */
  filled: FilledView | null;
}

export function fitLabel(count: number): string {
  if (count <= 0) return 'Nobody fits';
  return count === 1 ? '1 person fits' : `${count} people fit`;
}

/** "(506) 555-0140" -> "tel:+15065550140". Anything that is not 10 digits (or 1 + 10) keeps its digits only. */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `tel:+${digits}`;
  return `tel:${digits}`;
}

export function nobodyCopy(o: Pick<Opening, 'kind' | 'cancelled_at' | 'date' | 'start' | 'hours_notice'>): {
  head: string;
  why: string;
} {
  if (o.kind === 'no-show') return { head: NO_SHOW_HEAD, why: NO_SHOW_WHY };
  return {
    head: NOBODY_HEAD,
    why: `Nobody matches this therapist, day, time, length and notice (${noticeText(noticeMinutes(o))}).`,
  };
}

export function filledView(record: BookedRecord): FilledView {
  return { lineId: record.lineId, name: record.personName, at: record.at, atText: timestampText(record.at) };
}

/** The view of one opening: its booking when it has one, else the matcher's names (or nobody). */
export function openingView(opening: Opening, result: OpeningResult, booked: BookedRecord | null = null): OpeningView {
  const base = {
    id: opening.opening_id,
    date: opening.date,
    start: opening.start,
    therapist: opening.therapist,
    kind: opening.kind,
    summary: openingSummary(opening),
    joseeNote: opening.therapist === 'Josée Landry',
  };
  if (booked) {
    return { ...base, fitLabel: 'Filled', cards: [], short: false, nobody: null, filled: filledView(booked) };
  }
  const cards = result.suggestions.map((s, i) => ({
    n: i + 1,
    lineId: s.lineId,
    name: s.name,
    phone: s.phoneDisplay,
    tel: telHref(s.phoneDisplay),
  }));
  return {
    ...base,
    fitLabel: fitLabel(cards.length),
    cards,
    short: cards.length > 0 && cards.length < 3,
    nobody: cards.length === 0 ? nobodyCopy(opening) : null,
    filled: null,
  };
}

/** Date order (then start time); the file's own order breaks a tie. */
export function byDateOrder<T extends { date: string; start: string }>(items: T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => a.item.date.localeCompare(b.item.date) || a.item.start.localeCompare(b.item.start) || a.i - b.i)
    .map((x) => x.item);
}

export type FileFilter = 'all' | 'fit' | 'nobody';

/** An opening "has people" when it has names or is already filled. */
export const hasPeople = (o: OpeningView): boolean => o.filled !== null || o.cards.length > 0;

export interface FileCounts {
  searched: number;
  withPeople: number;
  nobody: number;
  filled: number;
}

export function fileCounts(openings: OpeningView[]): FileCounts {
  const withPeople = openings.filter(hasPeople).length;
  return {
    searched: openings.length,
    withPeople,
    nobody: openings.length - withPeople,
    filled: openings.filter((o) => o.filled !== null).length,
  };
}

/** "44 openings searched" / "1 opening searched". */
export function searchedText(n: number): string {
  return n === 1 ? '1 opening searched' : `${n} openings searched`;
}

/** "34 have people · 10 nobody", plus " · 1 filled" once something is booked. */
export function countsText(c: FileCounts): string {
  const base = `${c.withPeople} ${c.withPeople === 1 ? 'has' : 'have'} people · ${c.nobody} nobody`;
  return c.filled > 0 ? `${base} · ${c.filled} filled` : base;
}

export function filterOpenings(openings: OpeningView[], filter: FileFilter): OpeningView[] {
  if (filter === 'fit') return openings.filter(hasPeople);
  if (filter === 'nobody') return openings.filter((o) => !hasPeople(o));
  return openings;
}

/** "Show 36 more", or null when everything is shown. */
export function moreLabel(total: number, shown: number): string | null {
  const rest = total - shown;
  return rest > 0 ? `Show ${rest} more` : null;
}

/** "Already filled by Amanda Bourgeois (line W42)." */
export function alreadyFilledText(record: Pick<BookedRecord, 'personName' | 'lineId'>): string {
  return `Already filled by ${record.personName} (line ${record.lineId}).`;
}

/** "Matched against the waitlist imported in Waitlist (admin): Wed, Oct 21 · 30 people ready." */
export function matchedAgainstText(runDate: string, peopleReady: number): string {
  const people = peopleReady === 1 ? '1 person ready' : `${peopleReady} people ready`;
  return `Matched against the waitlist imported in Waitlist (admin): ${shortDate(runDate)} · ${people}.`;
}

/** "Booking export: Sat, Oct 17 · "booked since" is only as current as this file". */
export function bookingExportText(date: string | null): string {
  return `Booking export: ${date ? shortDate(date) : 'date unknown'} · "booked since" is only as current as this file`;
}
