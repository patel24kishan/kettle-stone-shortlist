// Import step, pure functions only (no file IO). Implements rules.md Step 1 (group lines, newest wins)
// and Step 2 (tag who can't be offered). Every line is kept; tags add a reason, nothing is dropped.
// Reference: build-plan.md sections 5.2 and 5.3.
import type {
  Appointment,
  BookedRecord,
  LineVerdict,
  Person,
  Reading,
  Tag,
  WaitlistLine,
} from '@/lib/types';
import { CLINIC_TIME_ZONE } from '@/lib/clinic';
import { canonicalName, formatPhone, shortDate, twoMonthCutoff } from '@/lib/normalise';

export interface BuildPeopleOptions {
  /** ISO date the import is run for (sample: 2026-10-21). */
  runDate: string;
  /** Booking export rows. */
  appointments: Appointment[];
  /** The note reading for one person's lines. Only `gone` and `availableUntil` are used here. */
  getReading: (group: WaitlistLine[]) => Pick<Reading, 'gone' | 'availableUntil'> | undefined;
  /** Bookings Tanya made through the tool (Booked button). */
  booked?: BookedRecord[];
}

export interface BuildPeopleResult {
  people: Person[];
  verdicts: Record<string, LineVerdict>;
  reasons: Record<string, string>;
}

// ---- Step 1: group lines into people -------------------------------------------------------

function words(name: string): string[] {
  return canonicalName(name)
    .replace(/\./g, '')
    .split(' ')
    .filter(Boolean);
}

/**
 * rules.md Step 1: same phone digits, or a "same #" line whose first name matches an earlier line and whose
 * second word (an initial such as "S." or "R") is a prefix of that line's surname. Groups are ordered by
 * first appearance; lines inside a group are oldest first.
 */
export function groupLines(lines: WaitlistLine[]): WaitlistLine[][] {
  const sorted = [...lines].sort((a, b) => a.n - b.n);
  const groups: WaitlistLine[][] = [];
  const groupOf = new Map<string, WaitlistLine[]>(); // line id -> its group
  const byDigits = new Map<string, WaitlistLine[]>(); // phone digits -> group
  const seen: WaitlistLine[] = [];

  for (const line of sorted) {
    let group: WaitlistLine[] | undefined;
    if (line.phoneDigits) {
      group = byDigits.get(line.phoneDigits);
    } else {
      const [first, initial] = words(line.name);
      if (first && initial) {
        for (let i = seen.length - 1; i >= 0; i--) {
          const earlier = seen[i]!;
          const [eFirst, eSecond] = words(earlier.name);
          if (eFirst === first && eSecond !== undefined && eSecond.startsWith(initial)) {
            group = groupOf.get(earlier.id);
            break;
          }
        }
      }
    }
    if (!group) {
      group = [];
      groups.push(group);
    }
    group.push(line);
    groupOf.set(line.id, group);
    seen.push(line);
    if (line.phoneDigits) byDigits.set(line.phoneDigits, group);
  }
  return groups;
}

// ---- Step 2: tags --------------------------------------------------------------------------

/** Canonical full name, but only when the surname is real (more than 2 letters). "Lynn S." gives null. */
function fullNameOrNull(name: string): string | null {
  const w = words(name);
  const surname = w.slice(1).join('');
  return surname.replace(/[^a-z]/g, '').length > 2 ? w.join(' ') : null;
}

/**
 * The clinic's calendar day for a Booked timestamp. The app saves `new Date().toISOString()` (UTC), so a 9:30 PM
 * booking in New Brunswick must still count as that day. Timestamps without a zone are already local.
 */
function clinicDay(timestamp: string, timeZone = CLINIC_TIME_ZONE): string {
  if (!/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(timestamp)) return timestamp.slice(0, 10);
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function isoDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function goneReason(gone: 'moved' | 'not in service' | 'going elsewhere'): string {
  if (gone === 'moved') return 'Moved away.';
  if (gone === 'not in service') return 'Number not in service.';
  return 'Going elsewhere.';
}

function staleTags(
  group: WaitlistLine[],
  newest: WaitlistLine,
  opts: BuildPeopleOptions,
  cutoff: string,
): Tag[] {
  const tags: Tag[] = [];
  const reading = opts.getReading(group);

  // rules.md Step 2, "No new line from them in over two months" (build-plan 5.3 item 1).
  if (newest.date < cutoff) {
    tags.push({ kind: 'stale', reason: `No call-back in over two months (last line ${shortDate(newest.date)}).` });
  }
  // "The notes say they've gone" (5.3 item 2).
  const gone = reading?.gone.value;
  if (gone) tags.push({ kind: 'stale', reason: goneReason(gone) });
  // "An end date has passed" (5.3 item 3).
  const until = reading?.availableUntil.value;
  if (until && until < opts.runDate) {
    tags.push({ kind: 'stale', reason: `Only here until ${shortDate(until)}; that date has passed.` });
  }
  // "They've booked since their newest line" (5.3 item 4). A booking made before the line does not count.
  const names = new Set<string>();
  for (const l of group) {
    const full = fullNameOrNull(l.name);
    if (full) names.add(full);
  }
  const booking = opts.appointments.find((a) => {
    if (a.status === 'Cancelled') return false;
    if (!names.has(canonicalName(a.client_name))) return false;
    const day = isoDay(a.booked_at);
    return day > newest.date && day <= opts.runDate;
  });
  if (booking) {
    tags.push({ kind: 'stale', reason: `Booked since: ${shortDate(isoDay(booking.booked_at))} as ${booking.client_name}.` });
  }
  return tags;
}

// "Tanya filled an opening with them" (rules.md Step 2, 5.3 item 5).
function bookedTags(group: WaitlistLine[], newest: WaitlistLine, booked: BookedRecord[]): Tag[] {
  const digits = new Set<string>();
  const names = new Set<string>();
  for (const l of group) {
    if (l.phoneDigits) digits.add(l.phoneDigits);
    const full = fullNameOrNull(l.name);
    if (full) names.add(full);
  }
  return booked
    .filter((b) => {
      const sameWho = digits.has(b.personPhoneDigits) || names.has(canonicalName(b.personName));
      // A line newer than the record cancels the tag (they called again).
      return sameWho && clinicDay(b.at) >= newest.date;
    })
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((b): Tag => ({
      kind: 'booked',
      reason: `Booked through the tool for ${b.openingId} on ${shortDate(clinicDay(b.at))}.`,
      openingId: b.openingId,
      at: b.at,
    }));
}

export function buildPeople(lines: WaitlistLine[], opts: BuildPeopleOptions): BuildPeopleResult {
  const cutoff = twoMonthCutoff(opts.runDate);
  const people: Person[] = [];
  const verdicts: Record<string, LineVerdict> = {};
  const reasons: Record<string, string> = {};

  for (const group of groupLines(lines)) {
    const newest = group[group.length - 1]!;
    const tags = [...staleTags(group, newest, opts, cutoff), ...bookedTags(group, newest, opts.booked ?? [])];

    // Full name = the longest name across the lines (the newest wins a tie).
    const name = group.reduce((best, l) => (l.name.length >= best.length ? l.name : best), '');
    // Phone from any line with digits (the newest one wins).
    const digits = [...group].reverse().find((l) => l.phoneDigits)?.phoneDigits ?? '';

    people.push({
      key: newest.id,
      lineIds: group.map((l) => l.id),
      newestId: newest.id,
      newestN: newest.n,
      newestDate: newest.date,
      name,
      phoneDigits: digits,
      phoneDisplay: formatPhone(digits),
      tags,
    });

    // A tag covers the whole person: stale beats duplicate.
    const reasonText = tags.map((t) => t.reason).join(' ');
    for (const l of group) {
      if (tags.length > 0) {
        verdicts[l.id] = 'stale';
        reasons[l.id] = reasonText;
      } else {
        verdicts[l.id] = l === newest ? 'active' : (`duplicate of ${newest.id}` as LineVerdict);
        reasons[l.id] = '';
      }
    }
  }
  return { people, verdicts, reasons };
}
