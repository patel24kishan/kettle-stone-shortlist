// CSV reading with a column check per file (build-plan section 3). The CSV files are never edited.
import Papa from 'papaparse';
import { DAYS, THERAPISTS } from '@/lib/types';
import type { Appointment, Day, Opening, Therapist, WaitlistLine } from '@/lib/types';
import { lineDate, phoneDigits } from '@/lib/normalise';

export type CsvKind = 'waitlist' | 'openings' | 'appointments' | 'answerKey';

export const REQUIRED_COLUMNS: Record<CsvKind, readonly string[]> = {
  waitlist: ['line', 'added', 'name', 'phone', 'notes'],
  openings: [
    'opening_id', 'appointment_id', 'date', 'day', 'start', 'length_min', 'therapist', 'kind',
    'cancelled_at', 'hours_notice', 'heard_via', 'client_had_confirmed', 'refilled', 'refilled_how',
    'booked_value_cad',
  ],
  appointments: [
    'appointment_id', 'date', 'start', 'end', 'length_min', 'service', 'therapist', 'client_id',
    'client_name', 'booked_at', 'booked_via', 'confirmation', 'status', 'cancelled_at', 'cancel_via',
    'late_fee', 'rebooked_into', 'desk_notes',
  ],
  answerKey: ['id', 'type', 'answer', 'marked_by', 'note'],
};

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseRaw(text: string) {
  return Papa.parse<Record<string, string>>(stripBom(text), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
}

/** Header row + data rows. Values are kept as written. */
export function parseCsv(text: string): Record<string, string>[] {
  return parseRaw(text).data;
}

export function checkColumns(text: string, kind: CsvKind): { ok: boolean; missing: string[]; rows: number } {
  const res = parseRaw(text);
  const found = new Set(res.meta.fields ?? []);
  const missing = REQUIRED_COLUMNS[kind].filter((c) => !found.has(c));
  return { ok: missing.length === 0, missing, rows: res.data.length };
}

function rowsOrThrow(text: string, kind: CsvKind, label: string): Record<string, string>[] {
  const check = checkColumns(text, kind);
  if (!check.ok) throw new Error(`The ${label} file is missing column(s): ${check.missing.join(', ')}.`);
  return parseCsv(text);
}

const v = (row: Record<string, string>, key: string): string => row[key] ?? '';

function toNumber(raw: string, what: string, where: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new Error(`${where}: "${raw}" is not a number for ${what}.`);
  return n;
}

export function parseWaitlist(text: string, runYear: number): WaitlistLine[] {
  return rowsOrThrow(text, 'waitlist', 'waitlist').map((r) => {
    const n = toNumber(v(r, 'line'), 'line', 'Waitlist');
    const added = v(r, 'added').trim();
    const phone = v(r, 'phone').trim();
    return {
      id: `W${String(n).padStart(2, '0')}`,
      n,
      added,
      date: lineDate(added, runYear),
      name: v(r, 'name').trim(),
      phone,
      phoneDigits: phoneDigits(phone),
      notes: v(r, 'notes'),
    };
  });
}

export function parseOpenings(text: string): Opening[] {
  return rowsOrThrow(text, 'openings', 'late openings').map((r) => {
    const id = v(r, 'opening_id');
    const day = v(r, 'day');
    const therapist = v(r, 'therapist');
    const kind = v(r, 'kind');
    if (!(DAYS as readonly string[]).includes(day)) throw new Error(`Opening ${id}: unknown day "${day}".`);
    if (!(THERAPISTS as readonly string[]).includes(therapist)) {
      throw new Error(`Opening ${id}: unknown therapist "${therapist}".`);
    }
    if (kind !== 'late cancel' && kind !== 'no-show') throw new Error(`Opening ${id}: unknown kind "${kind}".`);
    return {
      opening_id: id,
      appointment_id: v(r, 'appointment_id'),
      date: v(r, 'date'),
      day: day as Day,
      start: v(r, 'start'),
      length_min: toNumber(v(r, 'length_min'), 'length_min', `Opening ${id}`),
      therapist: therapist as Therapist,
      kind,
      cancelled_at: v(r, 'cancelled_at'),
      hours_notice: toNumber(v(r, 'hours_notice'), 'hours_notice', `Opening ${id}`),
      heard_via: v(r, 'heard_via'),
      client_had_confirmed: v(r, 'client_had_confirmed'),
      refilled: v(r, 'refilled'),
      refilled_how: v(r, 'refilled_how'),
      booked_value_cad: v(r, 'booked_value_cad'),
    };
  });
}

export function parseAppointments(text: string): Appointment[] {
  return rowsOrThrow(text, 'appointments', 'appointments').map((r) => ({
    appointment_id: v(r, 'appointment_id'),
    date: v(r, 'date'),
    start: v(r, 'start'),
    end: v(r, 'end'),
    length_min: v(r, 'length_min'),
    service: v(r, 'service'),
    therapist: v(r, 'therapist'),
    client_id: v(r, 'client_id'),
    client_name: v(r, 'client_name'),
    booked_at: v(r, 'booked_at'),
    booked_via: v(r, 'booked_via'),
    confirmation: v(r, 'confirmation'),
    status: v(r, 'status'),
    cancelled_at: v(r, 'cancelled_at'),
    cancel_via: v(r, 'cancel_via'),
    late_fee: v(r, 'late_fee'),
    rebooked_into: v(r, 'rebooked_into'),
    desk_notes: v(r, 'desk_notes'),
  }));
}
