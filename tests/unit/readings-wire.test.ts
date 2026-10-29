// The flat wire answer (what Claude returns) converts to the Reading shape validate.ts checks.
import { describe, expect, it } from 'vitest';
import { WireSchema, wireToReading } from '@/lib/readings/schema';
import { validateReading } from '@/lib/readings/validate';
import type { WaitlistLine } from '@/lib/types';

const lines: WaitlistLine[] = [
  { id: 'W12', n: 12, added: '8/26', date: '2026-08-26', name: 'x', phone: 'x', phoneDigits: '1', notes: 'not Thurs, anyone but Dave - 1hr - after 3:30 (work)' },
];

const wire = {
  therapistsAllowed: [],
  therapistsExcluded: ['Dave Melanson'],
  lengthMinutes: [60],
  lengthOnly: false,
  daysAllowed: [],
  daysExcluded: ['Thu'],
  startEarliest: '15:30',
  startLatest: '',
  endBy: '',
  noticeHours: 2,
  nextDayOnly: false,
  availableFrom: '',
  availableUntil: '',
  prenatal: false,
  gone: '',
  quotes: [
    { field: 'therapistsExcluded', lineId: 'W12', text: 'anyone but Dave' },
    { field: 'lengths', lineId: 'W12', text: '1hr' },
    { field: 'daysExcluded', lineId: 'W12', text: 'not Thurs' },
    { field: 'startEarliest', lineId: 'W12', text: 'after 3:30' },
  ],
  unclear: [],
};

describe('wire answer', () => {
  it('matches the wire schema', () => {
    expect(WireSchema.safeParse(wire).success).toBe(true);
  });

  it('converts to a Reading that passes validation with W12\'s expected values', () => {
    const { reading, problems } = validateReading(wireToReading(wire), lines);
    expect(problems).toEqual([]);
    expect(reading.therapistsAllowed.value).toBeNull();
    expect(reading.therapistsExcluded.value).toEqual(['Dave Melanson']);
    expect(reading.lengths.value).toEqual({ minutes: [60], only: false });
    expect(reading.daysAllowed.value).toBeNull();
    expect(reading.daysExcluded.value).toEqual(['Thu']);
    expect(reading.startEarliest.value).toBe('15:30');
    expect(reading.startLatest.value).toBeNull();
    expect(reading.gone.value).toBeNull();
    expect(reading.startEarliest.source).toEqual([{ lineId: 'W12', text: 'after 3:30' }]);
  });

  it('still rejects a bad value after conversion (unknown therapist -> default + unclear)', () => {
    const { reading, problems } = validateReading(wireToReading({ ...wire, therapistsExcluded: ['Nobody Here'] }), lines);
    expect(problems.length).toBeGreaterThan(0);
    expect(reading.therapistsExcluded.value).toEqual([]);
    expect(reading.unclear.some((u) => u.affects.includes('therapist'))).toBe(true);
  });

  it('passes a Reading-shaped answer through untouched', () => {
    const readingShaped = { lengths: { value: { minutes: [60], only: false }, source: [] } };
    expect(wireToReading(readingShaped)).toBe(readingShaped);
  });
});
