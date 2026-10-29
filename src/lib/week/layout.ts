// Pure layout helpers for the Week schedule screen (reference/mockups/A4-Week-schedule.dc.html, renderVals()):
// 88 px per hour, grid from 9:00 to 19:45, one column per therapist working that day.
import { THERAPISTS } from './sample-week';
import type { WeekRow, WeekStatus } from './sample-week';

export const PX_PER_HOUR = 88;
export const GRID_START_MIN = 9 * 60;
export const GRID_END_MIN = 19 * 60 + 45;
/** Height of the whole grid body in px (946). */
export const GRID_HEIGHT = ((GRID_END_MIN - GRID_START_MIN) / 60) * PX_PER_HOUR;

export interface BlockStyle {
  background: string;
  border: string;
  /** client name colour */
  ink: string;
  /** time-label colour */
  meta: string;
}

/** The five statuses as the mockup draws them (`look` table); Refilled is the white block with a solid teal border. */
export const STATUS_LOOK: Record<WeekStatus, BlockStyle & { prefix: string; legend: string }> = {
  Completed: { background: '#E6F4F1', border: '1px solid #5FA89E', ink: '#111827', meta: '#374151', prefix: '', legend: 'Booked' },
  Refilled: { background: '#FFFFFF', border: '2px solid #0F766E', ink: '#111827', meta: '#374151', prefix: 'Refilled · ', legend: 'Refilled' },
  'Late cancel': { background: '#FFF4E6', border: '2px dashed #C2410C', ink: '#9A3412', meta: '#7C2D12', prefix: 'Late cancel · open · ', legend: 'Late cancel, still open' },
  'No-show': { background: '#FDE2E4', border: '2px dashed #B91C1C', ink: '#991B1B', meta: '#7F1D1D', prefix: 'No-show · ', legend: 'No-show' },
  Cancelled: { background: '#F3F4F6', border: '1px dashed #6B7280', ink: '#1F2937', meta: '#374151', prefix: 'Cancelled ahead · ', legend: 'Cancelled 24h+ ahead' },
};

/** Legend order (mockup). */
export const LEGEND_STATUSES: readonly WeekStatus[] = ['Completed', 'Refilled', 'Late cancel', 'No-show', 'Cancelled'];

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** "13:45" -> "1:45 PM", "12:00" -> "12:00 PM", "09:00" -> "9:00 AM". */
export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
}

export interface Block {
  top: number;
  height: number;
  label: string;
  style: BlockStyle;
}

export function blockFor(row: Pick<WeekRow, 'start' | 'end' | 'status'>): Block {
  const look = STATUS_LOOK[row.status];
  const s = toMinutes(row.start);
  const e = toMinutes(row.end);
  return {
    top: ((s - GRID_START_MIN) / 60) * PX_PER_HOUR + 2,
    height: ((e - s) / 60) * PX_PER_HOUR - 4,
    label: `${look.prefix}${formatTime(row.start)} to ${formatTime(row.end)}`,
    style: { background: look.background, border: look.border, ink: look.ink, meta: look.meta },
  };
}

/** Therapists who have at least one appointment on `day`, in the fixed clinic order. */
export function columnsFor(day: string, week: readonly WeekRow[]): string[] {
  const working = new Set(week.filter((r) => r.day === day).map((r) => r.therapist));
  return THERAPISTS.filter((t) => working.has(t));
}

export function rowsForColumn(day: string, therapist: string, week: readonly WeekRow[]): WeekRow[] {
  return week.filter((r) => r.day === day && r.therapist === therapist).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

/** Header summary, e.g. "25 appointments · 4 late openings · 0 refilled". Late openings = late cancels still open + no-shows. */
export function daySummary(rows: readonly WeekRow[]): string {
  const late = rows.filter((r) => r.status === 'Late cancel' || r.status === 'No-show').length;
  const refilled = rows.filter((r) => r.status === 'Refilled').length;
  return `${rows.length} ${rows.length === 1 ? 'appointment' : 'appointments'} · ${late} late ${late === 1 ? 'opening' : 'openings'} · ${refilled} refilled`;
}

/** Hour labels down the left edge, 9:00 AM to 7:00 PM; the first one is nudged to top 2 as in the mockup. */
export function hourLabels(): { top: number; label: string }[] {
  const out: { top: number; label: string }[] = [];
  for (let h = 9; h <= 19; h++) {
    const top = (h - 9) * PX_PER_HOUR - 8;
    out.push({ top: top < 0 ? 2 : top, label: formatTime(`${h}:00`) });
  }
  return out;
}
