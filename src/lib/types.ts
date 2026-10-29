// Shared types for the shortlist. Rule sources: ../rules.md (backbone) and ../build-plan.md section 5.

export const THERAPISTS = [
  'Amira Haddad',
  'Dave Melanson',
  'Josée Landry',
  'Kelsey Babineau',
  'Marc Cormier',
  'Rachel Thibodeau',
] as const;
export type Therapist = (typeof THERAPISTS)[number];

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Day = (typeof DAYS)[number];

/** One row of the waitlist CSV, normalised. The CSV itself is never edited. */
export interface WaitlistLine {
  id: string; // "W01"
  n: number; // 1 = oldest
  added: string; // raw value from the CSV ("Jul 6", "7/14")
  date: string; // ISO yyyy-mm-dd, year = run year
  name: string; // as written ("Lynn S.")
  phone: string; // as written ("same #", "(506)555-0113")
  phoneDigits: string | null; // "5065550113", null for "same #"
  notes: string;
}

/** One row of the late openings CSV. */
export interface Opening {
  opening_id: string; // "O01"
  appointment_id: string;
  date: string; // ISO yyyy-mm-dd
  day: Day;
  start: string; // "HH:MM" 24h
  length_min: number;
  therapist: Therapist;
  kind: 'late cancel' | 'no-show';
  cancelled_at: string; // "yyyy-mm-dd HH:MM"
  hours_notice: number;
  heard_via: string;
  client_had_confirmed: string;
  refilled: string;
  refilled_how: string;
  booked_value_cad: string;
}

/** One row of the booking export (appointments CSV). Fields kept as strings. */
export interface Appointment {
  appointment_id: string;
  date: string;
  start: string;
  end: string;
  length_min: string;
  service: string;
  therapist: string;
  client_id: string;
  client_name: string;
  booked_at: string; // "yyyy-mm-dd HH:MM"
  booked_via: string;
  confirmation: string;
  status: string; // Completed | Late cancel | No-show | Cancelled
  cancelled_at: string;
  cancel_via: string;
  late_fee: string;
  rebooked_into: string;
  desk_notes: string;
}

/** Words quoted from a note, with the line they came from. */
export interface Quote {
  lineId: string;
  text: string;
}

/** A value read from the notes. `source` is empty when the value is a default (nothing written). */
export interface Field<T> {
  value: T;
  source: Quote[];
}

export type UnclearTopic = 'therapist' | 'length' | 'day' | 'time' | 'notice' | 'dates';

/**
 * What the notes say about one person (rules.md Step 1). Produced by Claude at import (B5),
 * validated by code, cached by a hash of the person's lines. Never contains names or phones.
 */
export interface Reading {
  therapistsAllowed: Field<Therapist[] | null>; // null = any therapist
  therapistsExcluded: Field<Therapist[]>;
  lengths: Field<{ minutes: number[]; only: boolean }>; // default { [60], false }; "90" alone => { [90], true }
  daysAllowed: Field<Day[] | null>; // null = any day
  daysExcluded: Field<Day[]>;
  startEarliest: Field<string | null>; // "HH:MM" inclusive, e.g. "after 3:30" => "15:30", afternoons => "12:00"
  startLatest: Field<string | null>; // "HH:MM" inclusive, e.g. AM => "11:59", lunch 12-1 => "12:30"
  endBy: Field<string | null>; // "HH:MM" inclusive, e.g. "done by 2:30" => "14:30"
  noticeHours: Field<number>; // default 2
  nextDayOnly: Field<boolean>; // must be cancelled on an earlier calendar day
  availableFrom: Field<string | null>; // ISO date, e.g. "away til Oct 9" => "2026-10-10"
  availableUntil: Field<string | null>; // ISO date, last day they can come ("only til end of Sept" => "2026-09-30")
  prenatal: Field<boolean>; // pregnancy rule applies. Source quotes for this field carry lineId only, text "" (never the words)
  gone: Field<null | 'moved' | 'not in service' | 'going elsewhere'>;
  unclear: { lineId: string; text: string; affects: UnclearTopic[] }[];
}

export type Tag =
  | { kind: 'stale'; reason: string }
  | { kind: 'booked'; reason: string; openingId: string; at: string };

/** A person built from one or more waitlist lines (rules.md Step 1). Every line is kept. */
export interface Person {
  key: string; // stable id: newest line id, e.g. "W42"
  lineIds: string[]; // oldest first
  newestId: string; // waitlist position used for ordering (rules.md Step 4)
  newestN: number;
  newestDate: string; // ISO date of the newest line
  name: string; // full name: the longest name across the lines
  phoneDigits: string; // "5065550125"
  phoneDisplay: string; // "(506) 555-0125"
  tags: Tag[]; // empty = active
}

export type LineVerdict = 'active' | 'stale' | `duplicate of W${string}`;

/** A record that Tanya filled an opening with this person (Booked button). */
export interface BookedRecord {
  personPhoneDigits: string;
  personName: string;
  lineId: string; // newest line at the time of booking
  openingId: string;
  at: string; // ISO timestamp
  by: string; // staff login or "local"
}

export interface Settings {
  noticeFrom: 'cancelled' | 'desk_free'; // rules.md "Still to decide" 1; default 'cancelled'
  allowLongerOpening: boolean; // rules.md "Still to decide" 2; default true
  noticeEqualIsEnough: boolean; // rules.md "Still to decide" 3; default true
}

export const DEFAULT_SETTINGS: Settings = {
  noticeFrom: 'cancelled',
  allowLongerOpening: true,
  noticeEqualIsEnough: true,
};

/** One check's outcome for one person and one opening (the reason trace). */
export interface CheckResult {
  check: string; // e.g. "therapist", "notice"
  pass: boolean;
  reason: string; // plain words, no health details
}

export interface Suggestion {
  lineId: string; // newest line id
  name: string;
  phoneDisplay: string;
}

export interface OpeningResult {
  openingId: string;
  suggestions: Suggestion[]; // up to 3, waitlist order; empty = nobody
  nobodyReason: string | null; // "No-show: there is no time to offer it." etc.
  joseeNote: boolean; // show "Josée wants to see who it is first."
  trace: { lineId: string; checks: CheckResult[] }[];
}
