// Plain-words B5 text (src/lib/format.ts) on the saved sample readings.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseWaitlist } from '@/lib/csv';
import {
  CLINIC_RULE_SOURCE,
  DEFAULT_SOURCE,
  availabilityText,
  clockText,
  hoursText,
  joinOr,
  lengthText,
  longDate,
  noticeText,
  readingCells,
  sourceText,
  therapistText,
  timestampText,
  todayIso,
  unclearText,
} from '@/lib/format';
import { groupLines } from '@/lib/import';
import { readingKey } from '@/lib/readings/hash';
import type { Reading } from '@/lib/types';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const lines = parseWaitlist(fs.readFileSync(SAMPLE + 'waitlist-2026-10-21.csv', 'utf8'), 2026);
const saved = JSON.parse(fs.readFileSync(SAMPLE + 'readings.json', 'utf8')) as Record<string, { reading: Reading }>;
const byNewest = new Map(groupLines(lines).map((g) => [g[g.length - 1]!.id, saved[readingKey(g, 2026)]!.reading]));
const R = (id: string): Reading => {
  const r = byNewest.get(id);
  if (!r) throw new Error(`no reading for ${id}`);
  return structuredClone(r);
};

describe('therapistText', () => {
  it('W12 anyone but Dave', () => expect(therapistText(R('W12'))).toBe('Anyone but Dave'));
  it('W33 anyone but Dave', () => expect(therapistText(R('W33'))).toBe('Anyone but Dave'));
  it('W39 any therapist', () => expect(therapistText(R('W39'))).toBe('Any therapist'));
  it('W40 clinic rule gives Amira or Kelsey', () => expect(therapistText(R('W40'))).toBe('Amira or Kelsey'));
  it('W53 any therapist', () => expect(therapistText(R('W53'))).toBe('Any therapist'));
  it('W55 Rachel or Amira', () => expect(therapistText(R('W55'))).toBe('Rachel or Amira'));
  it('W57 Dave or Josée', () => expect(therapistText(R('W57'))).toBe('Dave or Josée'));
  it('W20 female only', () => expect(therapistText(R('W20'))).toBe('Any female therapist'));
});

describe('lengthText', () => {
  it('W12 60 min', () => expect(lengthText(R('W12'))).toBe('60 min'));
  it('W39 30 or 45 min', () => expect(lengthText(R('W39'))).toBe('30 or 45 min'));
  it('W40 default 60 min', () => expect(lengthText(R('W40'))).toBe('60 min'));
  it('W53 60 or 90 min', () => expect(lengthText(R('W53'))).toBe('60 or 90 min'));
  it('W28 90 only', () => expect(lengthText(R('W28'))).toBe('90 min only'));
});

describe('availabilityText', () => {
  it('W12 not Thu, after 3:30', () => expect(availabilityText(R('W12'))).toBe('Not Thu · start 3:30 PM or later'));
  it('W33 not Mon, mornings', () => expect(availabilityText(R('W33'))).toBe('Not Mon · mornings'));
  it('W39 weekdays at lunch', () => expect(availabilityText(R('W39'))).toBe('Weekdays · start 12:00 PM to 12:30 PM'));
  it('W40 any day, any time', () => expect(availabilityText(R('W40'))).toBe('Any day, any time'));
  it('W53 not Sat, from Oct 10', () => expect(availabilityText(R('W53'))).toBe('Not Sat · from Oct 10'));
  it('W55 any day, any time', () => expect(availabilityText(R('W55'))).toBe('Any day, any time'));
  it('W57 afternoons', () => expect(availabilityText(R('W57'))).toBe('Afternoons (start 12:00 or later)'));
  it('W43 done by', () => expect(availabilityText(R('W43'))).toBe('Done by 2:30 PM'));
  it('W20 two days', () => expect(availabilityText(R('W20'))).toBe('Tue or Thu'));
  it('W11 until', () => expect(availabilityText(R('W11'))).toBe('Until Sep 30'));
});

describe('noticeText', () => {
  it('W12 default 2 h', () => expect(noticeText(R('W12'))).toBe('2 h'));
  it('W39 30 min', () => expect(noticeText(R('W39'))).toBe('30 min'));
  it('W40 3 h', () => expect(noticeText(R('W40'))).toBe('3 h'));
  it('W55 the day before', () => expect(noticeText(R('W55'))).toBe('The day before'));
  it('W57 2 h written', () => expect(noticeText(R('W57'))).toBe('2 h'));
  it('hoursText', () => {
    expect(hoursText(1)).toBe('1 h');
    expect(hoursText(1.5)).toBe('1 h 30 min');
    expect(hoursText(0.25)).toBe('15 min');
  });
});

describe('sourceText and the four cells', () => {
  it('quotes, older lines named, duplicates removed, default when nothing written', () => {
    expect(sourceText([{ lineId: 'W12', text: 'anyone but Dave' }], { newestId: 'W12' })).toBe('"anyone but Dave"');
    expect(sourceText([{ lineId: 'W26', text: '1hr' }], { newestId: 'W42' })).toBe('"1hr" (W26)');
    expect(
      sourceText(
        [
          { lineId: 'W39', text: 'on his lunch 12-1 only' },
          { lineId: 'W39', text: 'on his lunch 12-1 only' },
        ],
        { newestId: 'W39' },
      ),
    ).toBe('"on his lunch 12-1 only"');
    expect(sourceText([], { newestId: 'W12' })).toBe(DEFAULT_SOURCE);
  });

  it('W12 cells', () => {
    expect(readingCells(R('W12'), 'W12')).toEqual({
      therapist: { value: 'Anyone but Dave', source: '"anyone but Dave"' },
      length: { value: '60 min', source: '"1hr"' },
      availability: { value: 'Not Thu · start 3:30 PM or later', source: '"not Thurs", "after 3:30"' },
      notice: { value: '2 h', source: DEFAULT_SOURCE },
    });
  });

  it('W33 cells', () => {
    const c = readingCells(R('W33'), 'W33');
    expect(c.therapist.source).toBe('"AB Dave"');
    expect(c.availability).toEqual({ value: 'Not Mon · mornings', source: '"not Mon", "AM"' });
  });

  it('W40 (prenatal): clinic rule, wording hidden; the notice range names the higher number', () => {
    const c = readingCells(R('W40'), 'W40');
    expect(c.therapist).toEqual({ value: 'Amira or Kelsey', source: CLINIC_RULE_SOURCE });
    expect(c.length).toEqual({ value: '60 min', source: DEFAULT_SOURCE });
    expect(c.notice).toEqual({ value: '3 h', source: '"needs 2-3 hrs" (higher number)' });
  });

  it('W53 (merged W22): older-line quotes carry their line id', () => {
    const c = readingCells(R('W53'), 'W53');
    expect(c.therapist).toEqual({ value: 'Any therapist', source: '"any" (W22)' });
    expect(c.availability.value).toBe('Not Sat · from Oct 10');
    expect(c.availability.source).toContain('"not Sat"');
    expect(c.availability.source).toContain('(W22)');
  });

  it('W55 (merged W27): next day only', () => {
    const c = readingCells(R('W55'), 'W55');
    expect(c.notice).toEqual({ value: 'The day before', source: '"next day only" (W27)' });
    expect(c.length).toEqual({ value: '60 min', source: '"60" (W27)' });
  });

  it('W57 cells', () => {
    const c = readingCells(R('W57'), 'W57');
    expect(c.therapist).toEqual({ value: 'Dave or Josée', source: '"Dave or Jos"' });
    expect(c.availability).toEqual({ value: 'Afternoons (start 12:00 or later)', source: '"afternoons"' });
    expect(c.notice).toEqual({ value: '2 h', source: '"can come in 2 hrs"' });
  });

  it('W10 (prenatal, female only): still the clinic rule, and no note words', () => {
    const c = readingCells(R('W10'), 'W10');
    expect(c.therapist).toEqual({ value: 'Amira or Kelsey', source: CLINIC_RULE_SOURCE });
    expect(JSON.stringify(c)).not.toMatch(/female/i);
  });
});

describe('small helpers', () => {
  it('joinOr', () => {
    expect(joinOr([])).toBe('');
    expect(joinOr(['a'])).toBe('a');
    expect(joinOr(['a', 'b'])).toBe('a or b');
    expect(joinOr(['a', 'b', 'c'], 'and')).toBe('a, b and c');
  });
  it('clockText', () => {
    expect(clockText('15:30')).toBe('3:30 PM');
    expect(clockText('12:00')).toBe('12:00 PM');
    expect(clockText('00:15')).toBe('12:15 AM');
    expect(clockText('09:05')).toBe('9:05 AM');
  });
  it('dates', () => {
    expect(longDate('2026-10-17')).toBe('Sat, Oct 17, 2026');
    expect(todayIso(new Date('2026-10-30T02:00:00Z'))).toBe('2026-10-29'); // 11 PM in New Brunswick
    expect(timestampText('2026-10-29T18:07:14.454Z')).toBe('Oct 29, 3:07 PM');
  });
  it('unclearText never repeats note words', () => {
    expect(unclearText(['time', 'notice', 'time'])).toBe('Notes unclear about times and notice, so not offered.');
  });
});
