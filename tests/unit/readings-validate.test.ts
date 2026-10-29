import { describe, expect, it } from 'vitest';
import type { Reading, WaitlistLine } from '@/lib/types';
import { defaultReading, FIELD_KEYS, UNCLEAR_TOPICS } from '@/lib/readings/schema';
import { hasHealthWord, validateReading } from '@/lib/readings/validate';

function line(id: string, date: string, notes: string): WaitlistLine {
  return { id, n: Number(id.slice(1)), added: '', date, name: 'Never Sent', phone: '506-555-0000', phoneDigits: '5065550000', notes };
}

// Amanda's two lines (W26 + W42) and a pregnant client's one line.
const amanda = [
  line('W26', '2026-09-11', "MVA claim, ins pays - Rachel or Josée - 1hr"),
  line('W42', '2026-09-30', "can do 90 if ins ok's it. still R/J"),
];
const sarah = [line('W10', '2026-08-24', 'pregnant, 2nd tri - female - 60 - wkdays')];

function amandaReading(): Reading {
  return {
    ...defaultReading(),
    therapistsAllowed: { value: ['Rachel Thibodeau', 'Josée Landry'], source: [{ lineId: 'W42', text: 'R/J' }] },
    lengths: { value: { minutes: [60], only: false }, source: [{ lineId: 'W26', text: '1hr' }] },
  };
}

function sarahReading(): Reading {
  return {
    ...defaultReading(),
    therapistsAllowed: {
      value: ['Josée Landry', 'Amira Haddad', 'Kelsey Babineau', 'Rachel Thibodeau'],
      source: [{ lineId: 'W10', text: 'female' }],
    },
    daysAllowed: { value: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], source: [{ lineId: 'W10', text: 'wkdays' }] },
    prenatal: { value: true, source: [{ lineId: 'W10', text: '' }] },
  };
}

/** Asserts one field was reset to its default, marked unclear for `topic`, and reported. */
function expectReset(
  result: ReturnType<typeof validateReading>,
  key: keyof Omit<Reading, 'unclear'>,
  topic: string,
) {
  expect(result.reading[key]).toEqual(defaultReading()[key]);
  expect(result.reading.unclear.some((u) => u.affects.includes(topic as never))).toBe(true);
  expect(result.problems.some((p) => p.startsWith(`${key}:`))).toBe(true);
}

describe('validateReading: good readings pass unchanged', () => {
  it('two-line reading with quotes on both lines', () => {
    const raw = amandaReading();
    const r = validateReading(raw, amanda);
    expect(r.problems).toEqual([]);
    expect(r.reading).toEqual(raw);
  });

  it('quotes match case-insensitively and with any spacing', () => {
    const raw = amandaReading();
    raw.therapistsAllowed.source = [{ lineId: 'W26', text: '  rachel   OR josée ' }];
    expect(validateReading(raw, amanda).problems).toEqual([]);
  });

  it('prenatal with an empty-text quote passes', () => {
    const r = validateReading(sarahReading(), sarah);
    expect(r.problems).toEqual([]);
    expect(r.reading.prenatal).toEqual({ value: true, source: [{ lineId: 'W10', text: '' }] });
  });
});

describe('validateReading: a failing field becomes default + unclear + a problem', () => {
  it('bad quote text (not in the notes)', () => {
    const raw = amandaReading();
    raw.therapistsAllowed.source = [{ lineId: 'W42', text: 'Marc only' }];
    const r = validateReading(raw, amanda);
    expectReset(r, 'therapistsAllowed', 'therapist');
    expect(r.reading.lengths).toEqual(raw.lengths); // other fields untouched
  });

  it('quote on a foreign line id', () => {
    const raw = amandaReading();
    raw.lengths.source = [{ lineId: 'W05', text: '1hr' }];
    expectReset(validateReading(raw, amanda), 'lengths', 'length');
  });

  it('unknown therapist', () => {
    const raw = amandaReading() as unknown as Record<string, unknown>;
    raw.therapistsAllowed = { value: ['Rachel Thibodeau', 'Bob Smith'], source: [{ lineId: 'W42', text: 'R/J' }] };
    expectReset(validateReading(raw, amanda), 'therapistsAllowed', 'therapist');
  });

  it('unknown day', () => {
    const raw = sarahReading() as unknown as Record<string, unknown>;
    raw.daysAllowed = { value: ['Monday'], source: [{ lineId: 'W10', text: 'wkdays' }] };
    expectReset(validateReading(raw, sarah), 'daysAllowed', 'day');
  });

  it('bad time', () => {
    const raw = amandaReading();
    raw.startEarliest = { value: '3:30pm', source: [{ lineId: 'W42', text: 'still' }] };
    expectReset(validateReading(raw, amanda), 'startEarliest', 'time');
    raw.startEarliest = { value: '24:00', source: [{ lineId: 'W42', text: 'still' }] };
    expectReset(validateReading(raw, amanda), 'startEarliest', 'time');
  });

  it('bad date', () => {
    const raw = amandaReading();
    raw.availableFrom = { value: '2026-02-30', source: [{ lineId: 'W42', text: 'still' }] };
    expectReset(validateReading(raw, amanda), 'availableFrom', 'dates');
  });

  it('prenatal quote with text', () => {
    const raw = sarahReading();
    raw.prenatal.source = [{ lineId: 'W10', text: 'pregnant' }];
    const r = validateReading(raw, sarah);
    expectReset(r, 'prenatal', 'therapist');
    expect(JSON.stringify(r)).not.toMatch(/pregnant/i);
  });

  it('health-word quote', () => {
    const raw = amandaReading();
    raw.lengths.source = [{ lineId: 'W26', text: 'MVA claim, ins pays - Rachel or Josée - 1hr' }];
    const r = validateReading(raw, amanda);
    expectReset(r, 'lengths', 'length');
    // The problem names the line, never the words.
    expect(r.problems.join(' ')).not.toMatch(/MVA|claim/i);
  });

  it('a non-default value with no quote is not trusted', () => {
    const raw = amandaReading();
    raw.noticeHours = { value: 4, source: [] };
    expectReset(validateReading(raw, amanda), 'noticeHours', 'notice');
  });

  it('gone and availableUntil failures leave null and mark dates unclear', () => {
    const raw = amandaReading() as unknown as Record<string, unknown>;
    raw.gone = { value: 'retired', source: [{ lineId: 'W42', text: 'still' }] };
    raw.availableUntil = { value: 'end of Sept', source: [{ lineId: 'W42', text: 'still' }] };
    const r = validateReading(raw, amanda);
    expect(r.reading.gone).toEqual({ value: null, source: [] });
    expect(r.reading.availableUntil).toEqual({ value: null, source: [] });
    expect(r.reading.unclear.some((u) => u.affects.includes('dates'))).toBe(true);
    expect(r.problems.filter((p) => /^(gone|availableUntil):/.test(p))).toHaveLength(2);
  });

  it('a missing field is reset and reported', () => {
    const raw = amandaReading() as unknown as Record<string, unknown>;
    delete raw.endBy;
    expectReset(validateReading(raw, amanda), 'endBy', 'time');
  });

  it('not an object at all: every field default, every topic unclear', () => {
    const r = validateReading('nope', amanda);
    for (const k of FIELD_KEYS) expect(r.reading[k]).toEqual(defaultReading()[k]);
    const topics = new Set(r.reading.unclear.flatMap((u) => u.affects));
    expect([...topics].sort()).toEqual([...UNCLEAR_TOPICS].sort());
    expect(r.problems).toHaveLength(1);
  });
});

describe('validateReading: unclear entries', () => {
  it('keeps a good unclear entry as given', () => {
    const raw = amandaReading();
    raw.unclear = [{ lineId: 'W42', text: "can do 90 if ins ok's it", affects: ['length'] }];
    const r = validateReading(raw, amanda);
    expect(r.problems).toEqual([]);
    expect(r.reading.unclear).toEqual(raw.unclear);
  });

  it('never drops a bad entry: blanks health words and foreign words, keeps the topics', () => {
    const raw = amandaReading();
    raw.unclear = [
      { lineId: 'W26', text: 'MVA claim', affects: ['therapist'] },
      { lineId: 'W99', text: 'whatever', affects: ['time'] },
      { lineId: 'W42', text: 'not written there', affects: ['day'] },
    ];
    const r = validateReading(raw, amanda);
    expect(r.reading.unclear).toEqual([
      { lineId: 'W26', text: '', affects: ['therapist'] },
      { lineId: 'W42', text: '', affects: ['time'] },
      { lineId: 'W42', text: '', affects: ['day'] },
    ]);
    expect(r.problems).toHaveLength(3);
  });
});

describe('hasHealthWord', () => {
  it('matches whole words only', () => {
    expect(hasHealthWord('post-op shoulder')).toBe(true);
    expect(hasHealthWord('back now')).toBe(true);
    expect(hasHealthWord('migraines')).toBe(true);
    expect(hasHealthWord('op')).toBe(true);
    expect(hasHealthWord('TMJ')).toBe(true);
    expect(hasHealthWord('ok now')).toBe(false);
    expect(hasHealthWord('hospital')).toBe(false);
    expect(hasHealthWord('backpack')).toBe(false);
    expect(hasHealthWord('shipping')).toBe(false);
    expect(hasHealthWord('Kelsey or Josée')).toBe(false);
  });
});
