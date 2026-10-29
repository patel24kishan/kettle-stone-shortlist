// Unit tests for each rule check. Rule source: ../../../rules.md Steps 2-3 and build-plan.md section 5.4.
import { describe, expect, it } from 'vitest';
import { defaultReading } from '@/lib/readings/schema';
import {
  CHECKS,
  dates,
  day,
  hasReading,
  length,
  nextDay,
  noShow,
  noticeHoursFor,
  notTagged,
  notice,
  clinicRule,
  therapist,
  time,
  unclear,
} from '@/lib/rules';
import type { CheckContext } from '@/lib/rules';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { Opening, Person, Reading, Settings } from '@/lib/types';

function opening(over: Partial<Opening> = {}): Opening {
  return {
    opening_id: 'O99',
    appointment_id: 'A-1',
    date: '2026-10-07',
    day: 'Wed',
    start: '13:00',
    length_min: 60,
    therapist: 'Marc Cormier',
    kind: 'late cancel',
    cancelled_at: '2026-10-07 09:00',
    hours_notice: 4,
    heard_via: 'phone',
    client_had_confirmed: 'yes',
    refilled: 'no',
    refilled_how: '',
    booked_value_cad: '115',
    ...over,
  };
}

function person(over: Partial<Person> = {}): Person {
  return {
    key: 'W10',
    lineIds: ['W10'],
    newestId: 'W10',
    newestN: 10,
    newestDate: '2026-10-01',
    name: 'Test Person',
    phoneDigits: '5065550100',
    phoneDisplay: '(506) 555-0100',
    tags: [],
    ...over,
  };
}

/** A default reading with some fields replaced by plain values (no source quotes needed here). */
function reading(over: { [K in keyof Reading]?: Reading[K] extends { value: infer V } ? V : Reading[K] } = {}): Reading {
  const r = defaultReading() as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    r[k] = k === 'unclear' ? v : { value: v, source: [] };
  }
  return r as unknown as Reading;
}

function ctx(o: Partial<Opening> = {}, r: Reading | null = reading(), settings: Settings = DEFAULT_SETTINGS, p: Person = person()): CheckContext {
  return { opening: opening(o), person: p, reading: r, settings };
}

const settings = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('CHECKS order', () => {
  it('runs in the documented order', () => {
    expect(CHECKS.map((c) => c(ctx()).check)).toEqual([
      'noShow', 'notTagged', 'hasReading', 'therapist', 'clinicRule', 'length', 'day', 'time', 'notice', 'nextDay', 'dates', 'unclear',
    ]);
  });
  it('a default reading and an ordinary opening pass every check', () => {
    expect(CHECKS.map((c) => c(ctx()).pass)).toEqual(CHECKS.map(() => true));
  });
});

describe('noShow', () => {
  it('fails a no-show with the no-show reason', () => {
    const r = noShow(ctx({ kind: 'no-show' }));
    expect(r.pass).toBe(false);
    expect(r.reason).toBe('No-show: there is no time to offer it.');
  });
  it('passes a late cancellation', () => expect(noShow(ctx()).pass).toBe(true));
});

describe('notTagged', () => {
  it('passes an untagged person', () => expect(notTagged(ctx()).pass).toBe(true));
  it('fails a stale person and quotes the tag reason', () => {
    const r = notTagged(ctx({}, reading(), DEFAULT_SETTINGS, person({ tags: [{ kind: 'stale', reason: 'Moved away.' }] })));
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('Moved away.');
  });
  it('fails a booked person', () => {
    const tags: Person['tags'] = [{ kind: 'booked', reason: 'Booked into O05.', openingId: 'O05', at: '2026-10-21T10:00:00Z' }];
    const r = notTagged(ctx({}, reading(), DEFAULT_SETTINGS, person({ tags })));
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('Booked into O05.');
  });
});

describe('hasReading', () => {
  it('fails when the reading is null', () => {
    const r = hasReading(ctx({}, null));
    expect(r).toMatchObject({ pass: false, reason: 'Notes not read yet.' });
  });
  it('passes with a reading', () => expect(hasReading(ctx()).pass).toBe(true));
  it('every reading-based check fails (not throws) on a null reading', () => {
    for (const c of [therapist, clinicRule, length, day, time, notice, nextDay, dates, unclear]) {
      expect(c(ctx({}, null)).pass).toBe(false);
    }
  });
});

describe('therapist', () => {
  it('null allowed list means any therapist', () => expect(therapist(ctx()).pass).toBe(true));
  it('passes a therapist in the allowed list', () => {
    expect(therapist(ctx({}, reading({ therapistsAllowed: ['Marc Cormier', 'Dave Melanson'] }))).pass).toBe(true);
  });
  it('fails a therapist outside the allowed list', () => {
    expect(therapist(ctx({}, reading({ therapistsAllowed: ['Amira Haddad'] }))).pass).toBe(false);
  });
  it('fails an excluded therapist', () => {
    const r = therapist(ctx({ therapist: 'Dave Melanson' }, reading({ therapistsExcluded: ['Dave Melanson'] })));
    expect(r.pass).toBe(false);
    expect(r.reason).toContain('Dave Melanson');
  });
  it('passes a therapist who is not excluded', () => {
    expect(therapist(ctx({ therapist: 'Marc Cormier' }, reading({ therapistsExcluded: ['Dave Melanson'] }))).pass).toBe(true);
  });
});

describe('clinicRule (pregnancy rule)', () => {
  const pregnant = reading({ prenatal: true });
  it('fails Josée', () => expect(clinicRule(ctx({ therapist: 'Josée Landry' }, pregnant)).pass).toBe(false));
  it('passes Kelsey and Amira', () => {
    expect(clinicRule(ctx({ therapist: 'Kelsey Babineau' }, pregnant)).pass).toBe(true);
    expect(clinicRule(ctx({ therapist: 'Amira Haddad' }, pregnant)).pass).toBe(true);
  });
  it('does not apply when the flag is off', () => {
    expect(clinicRule(ctx({ therapist: 'Josée Landry' }, reading())).pass).toBe(true);
  });
  it('never says why in the reason', () => {
    expect(clinicRule(ctx({ therapist: 'Josée Landry' }, pregnant)).reason).not.toMatch(/pregnan|prenatal|baby/i);
  });
});

describe('length', () => {
  it('"90 only" needs a 90-minute opening', () => {
    const r = reading({ lengths: { minutes: [90], only: true } });
    expect(length(ctx({ length_min: 90 }, r)).pass).toBe(true);
    expect(length(ctx({ length_min: 60 }, r)).pass).toBe(false);
    expect(length(ctx({ length_min: 120 }, r)).pass).toBe(false); // longer is not OK for "only"
  });
  it('an exact length passes in both settings', () => {
    for (const allow of [true, false]) {
      expect(length(ctx({ length_min: 60 }, reading(), settings({ allowLongerOpening: allow }))).pass).toBe(true);
    }
  });
  it('a longer opening is allowed by default and refused when the setting is off', () => {
    expect(length(ctx({ length_min: 90 }, reading())).pass).toBe(true);
    expect(length(ctx({ length_min: 90 }, reading(), settings({ allowLongerOpening: false }))).pass).toBe(false);
  });
  it('a shorter opening than they asked for never passes', () => {
    expect(length(ctx({ length_min: 30 }, reading())).pass).toBe(false);
    expect(length(ctx({ length_min: 45 }, reading())).pass).toBe(false);
  });
  it('compares to the shortest of several lengths', () => {
    const r = reading({ lengths: { minutes: [45, 60], only: false } });
    expect(length(ctx({ length_min: 45 }, r)).pass).toBe(true);
    expect(length(ctx({ length_min: 90 }, r)).pass).toBe(true);
    expect(length(ctx({ length_min: 30 }, r)).pass).toBe(false);
  });
});

describe('day', () => {
  it('null allowed list means any day', () => expect(day(ctx()).pass).toBe(true));
  it('fails an excluded day', () => {
    expect(day(ctx({ day: 'Thu' }, reading({ daysExcluded: ['Thu'] }))).pass).toBe(false);
    expect(day(ctx({ day: 'Wed' }, reading({ daysExcluded: ['Thu'] }))).pass).toBe(true);
  });
  it('requires a day in the allowed list', () => {
    const r = reading({ daysAllowed: ['Mon', 'Wed'] });
    expect(day(ctx({ day: 'Wed' }, r)).pass).toBe(true);
    expect(day(ctx({ day: 'Tue' }, r)).pass).toBe(false);
  });
});

describe('time', () => {
  it('start before the earliest fails; at the earliest passes (inclusive)', () => {
    const r = reading({ startEarliest: '15:30' });
    expect(time(ctx({ start: '15:15' }, r)).pass).toBe(false);
    expect(time(ctx({ start: '15:30' }, r)).pass).toBe(true);
    expect(time(ctx({ start: '16:00' }, r)).pass).toBe(true);
  });
  it('start after the latest fails; at the latest passes (inclusive)', () => {
    const r = reading({ startLatest: '11:59' });
    expect(time(ctx({ start: '11:45' }, r)).pass).toBe(true);
    expect(time(ctx({ start: '11:59' }, r)).pass).toBe(true);
    expect(time(ctx({ start: '12:00' }, r)).pass).toBe(false);
  });
  it('endBy 14:30 with a 90-minute slot: 13:00 ends 14:30 (passes), 13:15 ends 14:45 (fails)', () => {
    const r = reading({ endBy: '14:30' });
    expect(time(ctx({ start: '13:00', length_min: 90 }, r)).pass).toBe(true);
    expect(time(ctx({ start: '13:15', length_min: 90 }, r)).pass).toBe(false);
    expect(time(ctx({ start: '13:30', length_min: 60 }, r)).pass).toBe(true); // ends exactly 14:30
    expect(time(ctx({ start: '13:45', length_min: 60 }, r)).pass).toBe(false);
    expect(time(ctx({ start: '13:45', length_min: 45 }, r)).pass).toBe(true);
  });
  it('no limits set means any time', () => expect(time(ctx({ start: '19:00' })).pass).toBe(true));
});

describe('notice', () => {
  it('more notice than needed passes; less fails', () => {
    expect(notice(ctx({ hours_notice: 2.1 })).pass).toBe(true);
    expect(notice(ctx({ hours_notice: 1.9 })).pass).toBe(false);
  });
  it('exactly equal passes by default and fails when the setting is off', () => {
    expect(notice(ctx({ hours_notice: 2 })).pass).toBe(true);
    expect(notice(ctx({ hours_notice: 2 }, reading(), settings({ noticeEqualIsEnough: false }))).pass).toBe(false);
    expect(notice(ctx({ hours_notice: 2.1 }, reading(), settings({ noticeEqualIsEnough: false }))).pass).toBe(true);
  });
  it('uses the person\'s own notice hours', () => {
    expect(notice(ctx({ hours_notice: 3 }, reading({ noticeHours: 4 }))).pass).toBe(false);
    expect(notice(ctx({ hours_notice: 0.5 }, reading({ noticeHours: 0.5 }))).pass).toBe(true);
  });
  describe('desk_free (counted from 10:30 on the opening date, or from the cancellation if later)', () => {
    const desk = settings({ noticeFrom: 'desk_free' });
    // Cancelled 07:12, opening 11:00: the key counts 3.8 hours; from 10:30 there is only 0.5.
    const early = { cancelled_at: '2026-10-07 07:12', start: '11:00', hours_notice: 3.8 };
    it('counts from 10:30 when the cancellation came earlier', () => {
      expect(noticeHoursFor(opening(early), desk)).toBeCloseTo(0.5, 9);
      expect(notice(ctx(early, reading(), DEFAULT_SETTINGS)).pass).toBe(true); // cancelled: 3.8h
      expect(notice(ctx(early, reading(), desk)).pass).toBe(false); // desk_free: 0.5h < 2
      expect(notice(ctx(early, reading({ noticeHours: 0.5 }), desk)).pass).toBe(true); // 0.5 equal
    });
    it('counts from the cancellation when it came after 10:30', () => {
      const late = { cancelled_at: '2026-10-07 11:22', start: '14:00', hours_notice: 2.6 };
      expect(noticeHoursFor(opening(late), desk)).toBeCloseTo(2.6333, 3);
      expect(notice(ctx(late, reading(), desk)).pass).toBe(true);
    });
    it('a cancellation exactly at 10:30 counts from 10:30', () => {
      expect(noticeHoursFor(opening({ cancelled_at: '2026-10-07 10:30', start: '12:30' }), desk)).toBeCloseTo(2, 9);
    });
    it('an overnight cancellation (the evening before) counts from 10:30 on the day', () => {
      expect(noticeHoursFor(opening({ cancelled_at: '2026-10-06 23:22', start: '11:45' }), desk)).toBeCloseTo(1.25, 9);
    });
    it('the cancelled setting just returns the opening\'s own hours_notice', () => {
      expect(noticeHoursFor(opening(early), DEFAULT_SETTINGS)).toBe(3.8);
    });
  });
});

describe('nextDay', () => {
  const r = reading({ nextDayOnly: true });
  it('not required: always passes', () => expect(nextDay(ctx()).pass).toBe(true));
  it('same-day cancellation fails', () => {
    expect(nextDay(ctx({ cancelled_at: '2026-10-07 06:00' }, r)).pass).toBe(false);
  });
  it('a cancellation the previous day passes', () => {
    expect(nextDay(ctx({ cancelled_at: '2026-10-06 22:30' }, r)).pass).toBe(true);
  });
});

describe('dates', () => {
  it('no dates set always passes', () => expect(dates(ctx()).pass).toBe(true));
  it('availableFrom: the day before fails, the day itself passes (inclusive)', () => {
    const r = reading({ availableFrom: '2026-10-07' });
    expect(dates(ctx({ date: '2026-10-06' }, r)).pass).toBe(false);
    expect(dates(ctx({ date: '2026-10-07' }, r)).pass).toBe(true);
    expect(dates(ctx({ date: '2026-10-08' }, r)).pass).toBe(true);
  });
  it('availableUntil: the day itself passes (inclusive), the day after fails', () => {
    const r = reading({ availableUntil: '2026-10-07' });
    expect(dates(ctx({ date: '2026-10-06' }, r)).pass).toBe(true);
    expect(dates(ctx({ date: '2026-10-07' }, r)).pass).toBe(true);
    expect(dates(ctx({ date: '2026-10-08' }, r)).pass).toBe(false);
  });
});

describe('unclear', () => {
  it('nothing unclear passes', () => expect(unclear(ctx()).pass).toBe(true));
  it('any unclear entry fails and names the topics only', () => {
    const r = reading({ unclear: [{ lineId: 'W10', text: 'sciatica maybe Tues?', affects: ['day', 'time'] }] });
    const res = unclear(ctx({}, r));
    expect(res.pass).toBe(false);
    expect(res.reason).toBe('Notes unclear about day, time.');
    expect(res.reason).not.toContain('sciatica');
  });
  it('lists each topic once', () => {
    const r = reading({
      unclear: [
        { lineId: 'W10', text: 'a', affects: ['day'] },
        { lineId: 'W11', text: 'b', affects: ['day', 'notice'] },
      ],
    });
    expect(unclear(ctx({}, r)).reason).toBe('Notes unclear about day, notice.');
  });
});
