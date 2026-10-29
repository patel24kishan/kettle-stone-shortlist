// The three files B5 imports, with the labels and column hints from the B5 mockup. Pure; safe in client code.
import type { InputKind } from '@/lib/storage/types';

export type { InputKind } from '@/lib/storage/types';

export const INPUT_KINDS: InputKind[] = ['waitlist', 'openings', 'appointments'];

export const FILE_LABELS: Record<InputKind, { label: string; hint: string; unit: string }> = {
  waitlist: { label: 'Waitlist CSV', hint: 'line, added, name, phone, notes', unit: 'lines' },
  openings: {
    label: 'Late openings CSV',
    hint: 'opening_id, date, start, length_min, therapist, kind, cancelled_at, hours_notice …',
    unit: 'openings',
  },
  appointments: { label: 'Booking export CSV', hint: 'Used to see who has booked since', unit: 'appointments' },
};

/** "60 lines · columns OK" or "Missing column(s): notes". */
export function fileCheckText(kind: InputKind, rows: number, missing: string[]): string {
  if (missing.length > 0) return `Missing column(s): ${missing.join(', ')}`;
  return `${rows} ${FILE_LABELS[kind].unit} · columns OK`;
}
