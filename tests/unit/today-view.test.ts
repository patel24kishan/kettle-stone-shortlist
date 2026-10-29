// Screen 3 text (reference/mockups/A3-Todays-openings.dc.html): the words are the mockup's.
import { describe, expect, it } from 'vitest';
import { TODAY_FOOTER, datesHint, goToText, noOpeningsText, openingsCount, todaySubtitle, todayTitle } from '@/lib/today-view';

describe('today-view', () => {
  it('heading line and card title', () => {
    expect(todaySubtitle('Wed, Oct 14', 3)).toBe('Wed, Oct 14 · 3 openings · up to 3 names each');
    expect(todaySubtitle('Thu, Oct 15', 1)).toBe('Thu, Oct 15 · 1 opening · up to 3 names each');
    expect(openingsCount(0)).toBe('0 openings');
    expect(todayTitle({ start: '11:00', therapist: 'Rachel Thibodeau' })).toBe('11:00 AM · Rachel Thibodeau');
    expect(todayTitle({ start: '15:00', therapist: 'Rachel Thibodeau' })).toBe('3:00 PM · Rachel Thibodeau');
  });

  it('footer is the mockup copy, word for word', () => {
    expect(TODAY_FOOTER).toBe(
      "Names are listed in waitlist order. Tap Booked once they've said yes and it's booked in Kneadly. They won't be suggested again, today or later. A no or no answer changes nothing.",
    );
  });

  it('empty day: message, hint from the file dates, quick link text', () => {
    expect(noOpeningsText('Sun, Oct 18')).toBe('No late openings on Sun, Oct 18.');
    expect(datesHint({ first: '2026-09-21', last: '2026-10-17' })).toBe('The imported late openings run Sep 21 to Oct 17.');
    expect(datesHint({ first: '2026-10-17', last: '2026-10-17' })).toBe('The imported late openings are all on Oct 17.');
    expect(datesHint({ first: null, last: null })).toBeNull();
    expect(goToText('2026-10-17')).toBe('Go to Sat, Oct 17');
  });
});
