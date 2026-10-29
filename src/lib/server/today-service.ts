// Screen 3 "Today's openings" server side (build-plan section 6 Screen 3): every late opening on one date, each
// with up to 3 names, from the imported late openings file. It uses the same current run and the same matcher
// as the Search screen (getCurrent, matchAll, openingView), so a person marked Booked for one opening is
// already left out of every other opening on the page. Never calls Claude.
// rules.md "Always": only names, phones, line ids and the openings leave this file.
// Server only.
import { parseOpenings } from '@/lib/csv';
import { matchAll } from '@/lib/match';
import { byDateOrder, isRealDate, openingView, shortDate } from '@/lib/search-view';
import { getCurrent } from '@/lib/server/current';
import { NO_IMPORT_MESSAGE, bookedByOpening, readingsOf, searchContext } from '@/lib/server/search-service';
import type { Failure, SearchContext } from '@/lib/server/search-service';
import type { OpeningDates, TodayOpeningView } from '@/lib/today-view';
import type { Store } from '@/lib/storage/types';

export type TodayResult =
  | {
      ok: true;
      /** The date asked for, YYYY-MM-DD. */
      date: string;
      /** "Wed, Oct 14" */
      dateLabel: string;
      /** How many openings are on that date. */
      count: number;
      /** That date's openings, in start-time order. */
      openings: TodayOpeningView[];
      /** First and last date in the imported late openings file (for the "no openings" hint). */
      dates: OpeningDates;
      context: SearchContext;
    }
  | Failure;

/** The openings on `date` (YYYY-MM-DD) in the latest import, each as the Search screen's display model. */
export async function todayOpenings(store: Store, dateRaw: unknown): Promise<TodayResult> {
  const date = typeof dateRaw === 'string' ? dateRaw.trim() : '';
  if (!isRealDate(date)) return { ok: false, status: 400, message: 'Choose a date (YYYY-MM-DD).' };

  const current = await getCurrent(store);
  if (!current) return { ok: false, status: 409, message: NO_IMPORT_MESSAGE, noImport: true };

  let all;
  try {
    all = parseOpenings(current.imp.files.openings.text);
  } catch (err) {
    return { ok: false, status: 400, message: err instanceof Error ? err.message : String(err) };
  }

  const dayOpenings = byDateOrder(all.filter((o) => o.date === date));
  const results = matchAll(dayOpenings, current.run.people, readingsOf(current.run));
  const booked = bookedByOpening(current.booked);
  const openings: TodayOpeningView[] = dayOpenings.map((o, i) => ({
    ...openingView(o, results[i]!, booked.get(o.opening_id) ?? null),
    lengthMin: o.length_min,
  }));

  const dates = all.map((o) => o.date).sort();
  return {
    ok: true,
    date,
    dateLabel: shortDate(date),
    count: openings.length,
    openings,
    dates: { first: dates[0] ?? null, last: dates[dates.length - 1] ?? null },
    context: searchContext(current),
  };
}
