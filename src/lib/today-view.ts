// Text for Screen 3, Today's openings (reference/mockups/A3-Todays-openings.dc.html; build-plan section 6
// Screen 3). Pure: no I/O, safe in client code. The cards themselves are the Search screen's OpeningView.
import { clockText, monthDay } from '@/lib/format';
import { shortDate } from '@/lib/search-view';
import type { OpeningView } from '@/lib/search-view';

/** The footer under the grid, word for word from the mockup. */
export const TODAY_FOOTER =
  "Names are listed in waitlist order. Tap Booked once they've said yes and it's booked in Kneadly. They won't be suggested again, today or later. A no or no answer changes nothing.";

/** An opening card on this screen: the Search view plus its length (the mockup shows "60 min" under the title). */
export type TodayOpeningView = OpeningView & { lengthMin: number };

/** First and last date in the imported late openings file (ISO), or null when the file has none. */
export interface OpeningDates {
  first: string | null;
  last: string | null;
}

/** "1 opening", "3 openings". */
export function openingsCount(n: number): string {
  return n === 1 ? '1 opening' : `${n} openings`;
}

/** "Wed, Oct 14 · 3 openings · up to 3 names each" */
export function todaySubtitle(dateLabel: string, count: number): string {
  return `${dateLabel} · ${openingsCount(count)} · up to 3 names each`;
}

/** "11:00 AM · Rachel Thibodeau" */
export function todayTitle(o: Pick<OpeningView, 'start' | 'therapist'>): string {
  return `${clockText(o.start)} · ${o.therapist}`;
}

/** "No late openings on Wed, Oct 14." */
export function noOpeningsText(dateLabel: string): string {
  return `No late openings on ${dateLabel}.`;
}

/** "The imported late openings run Sep 21 to Oct 17.", or null when the file has no openings. */
export function datesHint(dates: OpeningDates): string | null {
  if (!dates.first || !dates.last) return null;
  if (dates.first === dates.last) return `The imported late openings are all on ${monthDay(dates.first)}.`;
  return `The imported late openings run ${monthDay(dates.first)} to ${monthDay(dates.last)}.`;
}

/** The label of a quick link: "Go to Sat, Oct 17". */
export function goToText(iso: string): string {
  return `Go to ${shortDate(iso)}`;
}

/** The date label of a YYYY-MM-DD string: "Wed, Oct 14". */
export const dateLabel = shortDate;
