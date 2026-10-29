// The Search screen's display model (src/lib/search-view.ts): copy and formatting from the mockups A1, A1b, A2, A2b.
import { describe, expect, it } from 'vitest';
import { NO_SHOW_REASON, NOBODY_REASON } from '@/lib/match';
import {
  BOOKED_FOOTER,
  alreadyFilledText,
  bookingExportText,
  checkOneInput,
  countsText,
  fileCounts,
  filterOpenings,
  fitLabel,
  matchedAgainstText,
  moreLabel,
  noticeMinutes,
  noticeText,
  openingFromInput,
  openingSummary,
  openingView,
  queryOpeningId,
  searchedText,
  shortDate,
  telHref,
  timeRange,
} from '@/lib/search-view';
import type { BookedRecord, Opening, OpeningResult } from '@/lib/types';

const opening = (over: Partial<Opening> = {}): Opening => ({
  opening_id: 'O39',
  appointment_id: 'A-1',
  date: '2026-10-15',
  day: 'Thu',
  start: '14:00',
  length_min: 60,
  therapist: 'Dave Melanson',
  kind: 'late cancel',
  cancelled_at: '2026-10-15 10:40',
  hours_notice: 3.3,
  heard_via: '',
  client_had_confirmed: '',
  refilled: '',
  refilled_how: '',
  booked_value_cad: '',
  ...over,
});

const result = (n: number, over: Partial<OpeningResult> = {}): OpeningResult => ({
  openingId: 'O39',
  suggestions: [
    { lineId: 'W46', name: 'Shawn Duguay', phoneDisplay: '(506) 555-0140' },
    { lineId: 'W53', name: 'Luc Bernard', phoneDisplay: '(506) 555-0121' },
    { lineId: 'W57', name: 'Lise Gautreau', phoneDisplay: '(506) 555-0144' },
  ].slice(0, n),
  nobodyReason: n === 0 ? NOBODY_REASON : null,
  joseeNote: false,
  trace: [],
  ...over,
});

describe('fit labels', () => {
  it('counts the names', () => {
    expect(fitLabel(3)).toBe('3 people fit');
    expect(fitLabel(2)).toBe('2 people fit');
    expect(fitLabel(1)).toBe('1 person fits');
    expect(fitLabel(0)).toBe('Nobody fits');
  });
});

describe('summary', () => {
  it('same half of the day: one AM/PM at the end', () => {
    expect(openingSummary(opening())).toBe('Dave Melanson · Thu, Oct 15 · 2:00 to 3:00 PM · 60 min');
    expect(timeRange('09:00', 45)).toBe('9:00 to 9:45 AM');
  });
  it('across noon: both halves, 12:00 PM for noon', () => {
    expect(openingSummary(opening({ start: '11:00', therapist: 'Rachel Thibodeau', date: '2026-10-14' }))).toBe(
      'Rachel Thibodeau · Wed, Oct 14 · 11:00 AM to 12:00 PM · 60 min',
    );
    expect(timeRange('12:00', 30)).toBe('12:00 to 12:30 PM');
    expect(timeRange('11:30', 90)).toBe('11:30 AM to 1:00 PM');
  });
  it('end time comes from the length', () => {
    expect(timeRange('15:15', 60)).toBe('3:15 to 4:15 PM');
    expect(timeRange('13:45', 90)).toBe('1:45 to 3:15 PM');
    expect(openingSummary(opening({ length_min: 90, start: '16:00' }))).toBe('Dave Melanson · Thu, Oct 15 · 4:00 to 5:30 PM · 90 min');
  });
  it('short dates', () => {
    expect(shortDate('2026-10-21')).toBe('Wed, Oct 21');
    expect(shortDate('2026-10-17')).toBe('Sat, Oct 17');
  });
});

describe('notice', () => {
  it('text', () => {
    expect(noticeText(74)).toBe('1 h 14 min');
    expect(noticeText(45)).toBe('45 min');
    expect(noticeText(120)).toBe('2 h');
  });
  it('minutes come from cancelled_at to the start, across midnight too', () => {
    expect(noticeMinutes(opening({ start: '15:15', cancelled_at: '2026-10-08 14:01', date: '2026-10-08' }))).toBe(74);
    expect(noticeMinutes(opening({ start: '11:00', date: '2026-10-14', cancelled_at: '2026-10-13 21:30' }))).toBe(810);
  });
  it('falls back to hours_notice when cancelled_at cannot be read', () => {
    expect(noticeMinutes(opening({ cancelled_at: '', hours_notice: 1.5 }))).toBe(90);
  });
});

describe('nobody copy', () => {
  it('late cancel: nobody matches, with the notice', () => {
    const v = openingView(opening({ start: '16:00', cancelled_at: '2026-10-15 14:43', therapist: 'Rachel Thibodeau' }), result(0));
    expect(v.fitLabel).toBe('Nobody fits');
    expect(v.nobody).toEqual({
      head: 'No one on the waitlist can take this opening.',
      why: 'Nobody matches this therapist, day, time, length and notice (1 h 17 min).',
    });
    expect(v.short).toBe(false);
  });
  it('no-show: no time to offer it', () => {
    const v = openingView(opening({ kind: 'no-show', cancelled_at: '2026-10-15 14:15' }), result(0, { nobodyReason: NO_SHOW_REASON }));
    expect(v.nobody).toEqual({
      head: NO_SHOW_REASON,
      why: 'We only know 15 minutes after the start, so the waitlist isn’t searched.',
    });
  });
});

describe('cards', () => {
  it('numbered in order with tel links; short when fewer than 3', () => {
    const three = openingView(opening(), result(3));
    expect(three.cards.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(three.short).toBe(false);
    expect(three.cards[0]).toEqual({ n: 1, lineId: 'W46', name: 'Shawn Duguay', phone: '(506) 555-0140', tel: 'tel:+15065550140' });
    const two = openingView(opening(), result(2));
    expect(two.short).toBe(true);
    expect(two.fitLabel).toBe('2 people fit');
    expect(openingView(opening(), result(1)).short).toBe(true);
  });
  it('tel href', () => {
    expect(telHref('(506) 555-0140')).toBe('tel:+15065550140');
    expect(telHref('1-506-555-0140')).toBe('tel:+15065550140');
    expect(telHref('555-0140')).toBe('tel:5550140');
  });
  it('Josée note on her openings only', () => {
    expect(openingView(opening({ therapist: 'Josée Landry' }), result(1)).joseeNote).toBe(true);
    expect(openingView(opening(), result(1)).joseeNote).toBe(false);
  });
  it('a booked opening is filled instead of suggestions', () => {
    const rec: BookedRecord = {
      personPhoneDigits: '5065550125',
      personName: 'Amanda Bourgeois',
      lineId: 'W42',
      openingId: 'O39',
      at: '2026-10-29T18:07:00.000Z',
      by: 'local',
    };
    const v = openingView(opening(), result(3), rec);
    expect(v.fitLabel).toBe('Filled');
    expect(v.cards).toEqual([]);
    expect(v.nobody).toBeNull();
    expect(v.filled).toEqual({ lineId: 'W42', name: 'Amanda Bourgeois', at: rec.at, atText: 'Oct 29, 3:07 PM' });
    expect(alreadyFilledText(rec)).toBe('Already filled by Amanda Bourgeois (line W42).');
  });
});

describe('file view helpers', () => {
  const views = [openingView(opening(), result(3)), openingView(opening({ opening_id: 'O40' }), result(0)), openingView(opening({ opening_id: 'O41' }), result(1))];
  it('counts and filters', () => {
    const c = fileCounts(views);
    expect(c).toEqual({ searched: 3, withPeople: 2, nobody: 1, filled: 0 });
    expect(searchedText(44)).toBe('44 openings searched');
    expect(countsText({ searched: 44, withPeople: 34, nobody: 10, filled: 0 })).toBe('34 have people · 10 nobody');
    expect(countsText({ searched: 44, withPeople: 34, nobody: 10, filled: 1 })).toBe('34 have people · 10 nobody · 1 filled');
    expect(filterOpenings(views, 'fit').map((v) => v.id)).toEqual(['O39', 'O41']);
    expect(filterOpenings(views, 'nobody').map((v) => v.id)).toEqual(['O40']);
    expect(filterOpenings(views, 'all')).toHaveLength(3);
  });
  it('show more', () => {
    expect(moreLabel(44, 8)).toBe('Show 36 more');
    expect(moreLabel(8, 8)).toBeNull();
  });
  it('screen copy', () => {
    expect(matchedAgainstText('2026-10-21', 30)).toBe('Matched against the waitlist imported in Waitlist (admin): Wed, Oct 21 · 30 people ready.');
    expect(bookingExportText('2026-10-17')).toBe('Booking export: Sat, Oct 17 · "booked since" is only as current as this file');
    expect(BOOKED_FOOTER).toBe(
      "Tap Booked once they've said yes and it's booked in Kneadly. They won't be suggested again, for this or any other opening. A no or no answer changes nothing.",
    );
  });
});

describe('one opening from the form', () => {
  const input = { date: '2026-10-15', start: '14:00', therapist: 'Dave Melanson', length: 60, cancelledAt: '2026-10-15T10:40' };
  it('builds a late cancel with day and notice', () => {
    const o = openingFromInput(input);
    expect(o).toMatchObject({ opening_id: 'Q-20261015-1400-DM', day: 'Thu', kind: 'late cancel', cancelled_at: '2026-10-15 10:40', length_min: 60 });
    expect(o.hours_notice).toBeCloseTo(200 / 60, 9);
  });
  it('ids are per slot', () => {
    expect(queryOpeningId('2026-10-15', '09:30', 'Josée Landry')).toBe('Q-20261015-0930-JL');
  });
  it('checks the form', () => {
    expect(checkOneInput(input)).toEqual([]);
    expect(checkOneInput({ ...input, length: 75 })).toHaveLength(1);
    expect(checkOneInput({ ...input, cancelledAt: '2026-10-15T14:01' })[0]).toContain('after the start');
    expect(checkOneInput({})).toHaveLength(5);
  });
});
