import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAppointments, parseCsv, parseWaitlist } from '@/lib/csv';
import { buildPeople, groupLines } from '@/lib/import';
import type { BuildPeopleOptions } from '@/lib/import';
import { lineDate, phoneDigits } from '@/lib/normalise';
import type { Appointment, BookedRecord, Reading, WaitlistLine } from '@/lib/types';

// ---- helpers --------------------------------------------------------------------------------

function mk(n: number, added: string, name: string, phone: string, notes = ''): WaitlistLine {
  return {
    id: `W${String(n).padStart(2, '0')}`,
    n,
    added,
    date: lineDate(added, 2026),
    name,
    phone,
    phoneDigits: phoneDigits(phone),
    notes,
  };
}

function appt(client_name: string, booked_at: string, status = 'Completed'): Appointment {
  return {
    appointment_id: 'A-1', date: '2026-10-01', start: '10:00', end: '11:00', length_min: '60', service: 'Massage',
    therapist: 'Dave Melanson', client_id: 'K-1', client_name, booked_at, booked_via: 'online', confirmation: '',
    status, cancelled_at: '', cancel_via: '', late_fee: '', rebooked_into: '', desk_notes: '',
  };
}

type PartReading = NonNullable<ReturnType<BuildPeopleOptions['getReading']>>;
function reading(opts: { gone?: 'moved' | 'not in service' | 'going elsewhere'; until?: string } = {}): PartReading {
  return {
    gone: { value: opts.gone ?? null, source: [] },
    availableUntil: { value: opts.until ?? null, source: [] },
  } satisfies Pick<Reading, 'gone' | 'availableUntil'>;
}

const RUN = '2026-10-21';
const none: BuildPeopleOptions['getReading'] = () => undefined;
const opts = (over: Partial<BuildPeopleOptions> = {}): BuildPeopleOptions => ({
  runDate: RUN,
  appointments: [],
  getReading: none,
  ...over,
});

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const sample = (f: string) => fs.readFileSync(SAMPLE + f, 'utf8');
const waitlistLines = () => parseWaitlist(sample('waitlist-2026-10-21.csv'), 2026);
const sampleAppointments = () => parseAppointments(sample('appointments-2026-09-21-to-2026-10-17.csv'));

// ---- grouping -------------------------------------------------------------------------------

describe('groupLines', () => {
  it('groups by phone digits and keeps first-appearance order', () => {
    const lines = [
      mk(1, 'Sep 1', 'Ann Lee', '506-555-0001'),
      mk(2, 'Sep 2', 'Bo Chan', '(506) 555-0002'),
      mk(3, 'Sep 3', 'Ann L.', '5065550001'),
    ];
    const groups = groupLines(lines);
    expect(groups.map((g) => g.map((l) => l.id))).toEqual([['W01', 'W03'], ['W02']]);
  });

  it('puts a "same #" line with a matching first name and initial into the earlier line group', () => {
    const lines = [
      mk(5, 'Aug 4', 'Lynn Savoie', '5065550105'),
      mk(6, 'Aug 5', 'Lorraine Johnson', '506-555-0106'),
      mk(7, 'Aug 11', 'Lynn S.', 'same #'),
    ];
    const groups = groupLines(lines);
    expect(groups.map((g) => g.map((l) => l.id))).toEqual([['W05', 'W07'], ['W06']]);
  });

  it('does not join a "same #" line whose initial does not match the surname', () => {
    const lines = [mk(1, 'Aug 4', 'Lynn Savoie', '5065550105'), mk(2, 'Aug 11', 'Lynn T.', 'same #')];
    expect(groupLines(lines)).toHaveLength(2);
  });

  it('treats "Same #" in any case', () => {
    const lines = [mk(1, 'Aug 4', 'Claudette Richard', '506-555-0108'), mk(2, 'Aug 5', 'Claudette R', 'Same #')];
    expect(groupLines(lines)).toHaveLength(1);
  });

  it('sample: W07 joins W05 (Lynn) and W31 joins W09 (Claudette)', () => {
    const groups = groupLines(waitlistLines()).map((g) => g.map((l) => l.id));
    expect(groups).toContainEqual(['W05', 'W07']);
    expect(groups).toContainEqual(['W09', 'W31']);
  });

  it('sample: W26 and W42 (Amanda) share a phone number', () => {
    const groups = groupLines(waitlistLines()).map((g) => g.map((l) => l.id));
    expect(groups).toContainEqual(['W26', 'W42']);
  });

  it('sample: every line lands in exactly one group, 45 groups for 60 lines', () => {
    const lines = waitlistLines();
    const groups = groupLines(lines);
    expect(groups.flat()).toHaveLength(lines.length);
    expect(new Set(groups.flat().map((l) => l.id)).size).toBe(lines.length);
    expect(groups).toHaveLength(45);
    for (const g of groups) expect(g.map((l) => l.n)).toEqual([...g.map((l) => l.n)].sort((a, b) => a - b));
  });
});

// ---- people ---------------------------------------------------------------------------------

describe('buildPeople: people', () => {
  it('uses the newest line as key, the longest name, and any phone with digits', () => {
    const lines = [
      mk(5, 'Aug 4', 'Lynn Savoie', '5065550105'),
      mk(7, 'Oct 1', 'Lynn S.', 'same #'),
    ];
    const { people, verdicts, reasons } = buildPeople(lines, opts());
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      key: 'W07',
      newestId: 'W07',
      newestN: 7,
      newestDate: '2026-10-01',
      lineIds: ['W05', 'W07'],
      name: 'Lynn Savoie',
      phoneDigits: '5065550105',
      phoneDisplay: '(506) 555-0105',
      tags: [],
    });
    expect(verdicts).toEqual({ W05: 'duplicate of W07', W07: 'active' });
    expect(reasons).toEqual({ W05: '', W07: '' });
  });
});

describe('buildPeople: two-month cutoff', () => {
  const one = (added: string) => buildPeople([mk(1, added, 'Ann Lee', '506-555-0001')], opts());

  it('Aug 21 stays active for run date Oct 21', () => {
    const r = one('Aug 21');
    expect(r.verdicts.W01).toBe('active');
    expect(r.people[0]!.tags).toEqual([]);
  });

  it('Aug 20 is stale, with the reason', () => {
    const r = one('Aug 20');
    expect(r.verdicts.W01).toBe('stale');
    expect(r.people[0]!.tags).toEqual([
      { kind: 'stale', reason: 'No call-back in over two months (last line Aug 20).' },
    ]);
    expect(r.reasons.W01).toBe('No call-back in over two months (last line Aug 20).');
  });

  it('uses the newest line of the person, not the oldest', () => {
    const lines = [mk(1, 'Jul 6', 'Ann Lee', '506-555-0001'), mk(2, 'Oct 1', 'Ann Lee', '506-555-0001')];
    const r = buildPeople(lines, opts());
    expect(r.verdicts).toEqual({ W01: 'duplicate of W02', W02: 'active' });
  });

  it('clamps month ends: run date Dec 31 uses Oct 31', () => {
    const lines = [mk(1, 'Oct 30', 'Ann Lee', '506-555-0001'), mk(2, 'Oct 31', 'Bo Chan', '506-555-0002')];
    const r = buildPeople(lines, opts({ runDate: '2026-12-31' }));
    expect(r.verdicts).toEqual({ W01: 'stale', W02: 'active' });
  });
});

describe('buildPeople: readings', () => {
  it('tags people who are gone, with a reason per kind', () => {
    const lines = [
      mk(1, 'Oct 1', 'Ann Lee', '506-555-0001'),
      mk(2, 'Oct 1', 'Bo Chan', '506-555-0002'),
      mk(3, 'Oct 1', 'Cy Dunn', '506-555-0003'),
    ];
    const r = buildPeople(lines, opts({
      getReading: ([first]) =>
        first!.id === 'W01' ? reading({ gone: 'moved' })
          : first!.id === 'W02' ? reading({ gone: 'not in service' })
            : reading({ gone: 'going elsewhere' }),
    }));
    expect(r.reasons).toEqual({ W01: 'Moved away.', W02: 'Number not in service.', W03: 'Going elsewhere.' });
    expect(Object.values(r.verdicts)).toEqual(['stale', 'stale', 'stale']);
  });

  it('tags an end date that has passed, not one that has not', () => {
    const lines = [mk(1, 'Oct 1', 'Ann Lee', '506-555-0001'), mk(2, 'Oct 1', 'Bo Chan', '506-555-0002')];
    const r = buildPeople(lines, opts({
      getReading: ([first]) => reading({ until: first!.id === 'W01' ? '2026-10-10' : '2026-10-21' }),
    }));
    expect(r.verdicts).toEqual({ W01: 'stale', W02: 'active' });
    expect(r.reasons.W01).toBe('Only here until Oct 10; that date has passed.');
  });

  it('a tag covers the whole person: stale beats duplicate', () => {
    const lines = [
      mk(1, 'Sep 1', 'Brianne Cyr', '506-555-0116'),
      mk(2, 'Sep 21', 'Brianne Cyr', '506-555-0116'),
    ];
    const r = buildPeople(lines, opts({ getReading: () => reading({ until: '2026-10-02' }) }));
    expect(r.verdicts).toEqual({ W01: 'stale', W02: 'stale' });
    expect(r.reasons.W01).toBe(r.reasons.W02);
    expect(r.reasons.W01).not.toBe('');
  });

  it('keeps every reason when several rules apply', () => {
    const r = buildPeople([mk(1, 'Jul 6', 'Ann Lee', '506-555-0001')], opts({
      getReading: () => reading({ gone: 'moved' }),
    }));
    expect(r.people[0]!.tags).toHaveLength(2);
    expect(r.reasons.W01).toBe('No call-back in over two months (last line Jul 6). Moved away.');
  });
});

describe('buildPeople: booked since (booking export)', () => {
  it('matches a nickname: W15 Mel -> Melanie Arsenault booked Sep 24', () => {
    const lines = waitlistLines();
    const r = buildPeople(lines, opts({ appointments: sampleAppointments() }));
    expect(r.verdicts.W15).toBe('stale');
    expect(r.reasons.W15).toBe('Booked since: Sep 24 as Melanie Arsenault.');
  });

  it('does not tag Marcel Bujold (W18): his booking was made before his line', () => {
    const lines = waitlistLines();
    const marcel = sampleAppointments().filter((a) => a.client_name === 'Marcel Bujold');
    expect(marcel.length).toBeGreaterThan(0);
    const r = buildPeople(lines, opts({ appointments: sampleAppointments() }));
    expect(r.verdicts.W18).toBe('active');
    expect(r.reasons.W18).toBe('');
  });

  it('counts only bookings made after the newest line and on or before the run date', () => {
    const line = [mk(1, 'Oct 1', 'Ann Lee', '506-555-0001')];
    const verdict = (a: Appointment) => buildPeople(line, opts({ appointments: [a] })).verdicts.W01;
    expect(verdict(appt('Ann Lee', '2026-10-02 09:00'))).toBe('stale');
    expect(verdict(appt('Ann Lee', '2026-10-01 18:00'))).toBe('active'); // same day as the line: not after
    expect(verdict(appt('Ann Lee', '2026-09-20 09:00'))).toBe('active'); // before
    expect(verdict(appt('Ann Lee', '2026-10-22 09:00'))).toBe('active'); // after the run date
    expect(verdict(appt('Ann Lee', '2026-10-05 09:00', 'Cancelled'))).toBe('active');
    expect(verdict(appt('Ann Lee', '2026-10-05 09:00', 'Late cancel'))).toBe('stale');
  });

  it('ignores a short name such as "Lynn S." for booking matches', () => {
    const line = [mk(1, 'Oct 1', 'Lynn S.', '506-555-0001')];
    const r = buildPeople(line, opts({ appointments: [appt('Lynn S.', '2026-10-05 09:00')] }));
    expect(r.verdicts.W01).toBe('active');
  });

  it('matches any line of the group that has a real surname', () => {
    const lines = [mk(1, 'Sep 1', 'Lynn Savoie', '506-555-0001'), mk(2, 'Oct 1', 'Lynn S.', 'same #')];
    const r = buildPeople(lines, opts({ appointments: [appt('Lynn Savoie', '2026-10-05 09:00')] }));
    expect(r.verdicts).toEqual({ W01: 'stale', W02: 'stale' });
  });

  it('removes accents when matching names', () => {
    const line = [mk(1, 'Oct 1', 'Helene Surette', '506-555-0001')];
    const r = buildPeople(line, opts({ appointments: [appt('Hélène Surette', '2026-10-05 09:00')] }));
    expect(r.verdicts.W01).toBe('stale');
  });
});

describe('buildPeople: booked through the tool', () => {
  const lines = [mk(5, 'Oct 1', 'Ann Lee', '506-555-0001')];
  const rec = (over: Partial<BookedRecord> = {}): BookedRecord => ({
    personPhoneDigits: '5065550001',
    personName: 'Ann Lee',
    lineId: 'W05',
    openingId: 'O12',
    at: '2026-10-14T10:30:00Z',
    by: 'local',
    ...over,
  });

  it('tags a booked person by phone digits', () => {
    const r = buildPeople(lines, opts({ booked: [rec()] }));
    expect(r.verdicts.W05).toBe('stale');
    expect(r.people[0]!.tags).toEqual([
      { kind: 'booked', reason: 'Booked through the tool for O12 on Oct 14.', openingId: 'O12', at: '2026-10-14T10:30:00Z' },
    ]);
    expect(r.reasons.W05).toBe('Booked through the tool for O12 on Oct 14.');
  });

  it('tags by canonical name when the phone differs', () => {
    const r = buildPeople(lines, opts({ booked: [rec({ personPhoneDigits: '5060000000', personName: 'ANN LEE' })] }));
    expect(r.people[0]!.tags[0]!.kind).toBe('booked');
  });

  it('a record on the same day as the newest line still tags', () => {
    const r = buildPeople(lines, opts({ booked: [rec({ at: '2026-10-01T08:00:00Z' })] }));
    expect(r.people[0]!.tags).toHaveLength(1);
  });

  it('no tag when the person has a line newer than the record', () => {
    const r = buildPeople(lines, opts({ booked: [rec({ at: '2026-09-30T23:00:00Z' })] }));
    expect(r.people[0]!.tags).toEqual([]);
    expect(r.verdicts.W05).toBe('active');
  });

  it('ignores a record for someone else', () => {
    const r = buildPeople(lines, opts({ booked: [rec({ personPhoneDigits: '5060000000', personName: 'Bo Chan' })] }));
    expect(r.people[0]!.tags).toEqual([]);
  });

  it('covers older repeat lines too', () => {
    const two = [mk(1, 'Sep 1', 'Ann Lee', '506-555-0001'), mk(5, 'Oct 1', 'Ann Lee', '506-555-0001')];
    const r = buildPeople(two, opts({ booked: [rec()] }));
    expect(r.verdicts).toEqual({ W01: 'stale', W05: 'stale' });
  });
});

// ---- the gate: Tanya's answer key -----------------------------------------------------------

describe('gate: sample files against answer-key-tanya.csv', () => {
  const field = <T extends 'gone' | 'availableUntil'>(key: T, value: Reading[T]['value']): Pick<Reading, T>[T] =>
    ({ value, source: [] }) as Pick<Reading, T>[T];

  const readings: { ids: string[]; gone?: 'moved' | 'not in service' | 'going elsewhere'; until?: string }[] = [
    { ids: ['W23'], gone: 'moved' },
    { ids: ['W29'], gone: 'going elsewhere' },
    { ids: ['W13', 'W50'], gone: 'not in service' },
    { ids: ['W11'], until: '2026-09-30' },
    { ids: ['W32'], until: '2026-10-10' },
    { ids: ['W17', 'W34'], until: '2026-10-02' },
  ];

  const getReading: BuildPeopleOptions['getReading'] = (group) => {
    const hit = readings.find((r) => r.ids.some((id) => group.some((l) => l.id === id)));
    if (!hit) return undefined;
    return {
      gone: field('gone', hit.gone ?? null),
      availableUntil: field('availableUntil', hit.until ?? null),
    };
  };

  const lines = waitlistLines();
  const result = buildPeople(lines, { runDate: RUN, appointments: sampleAppointments(), getReading });
  const key = parseCsv(sample('answer-key-tanya.csv')).filter((r) => r.type === 'waitlist line');

  it('has 60 answer-key rows for the 60 lines', () => {
    expect(key).toHaveLength(60);
    expect(lines).toHaveLength(60);
  });

  it('matches every line verdict (60 of 60)', () => {
    const wrong = key
      .filter((k) => result.verdicts[k.id!] !== k.answer)
      .map((k) => `${k.id}: ours=${result.verdicts[k.id!]} key=${k.answer}`);
    expect(wrong).toEqual([]);
    expect(key.length - wrong.length).toBe(60);
  });

  it('keeps every line (nothing dropped)', () => {
    expect(Object.keys(result.verdicts)).toHaveLength(60);
    expect(result.people.flatMap((p) => p.lineIds)).toHaveLength(60);
  });

  it('finds 30 active people', () => {
    expect(result.people.filter((p) => p.tags.length === 0)).toHaveLength(30);
  });

  it('gives every stale line a reason and no other line one', () => {
    for (const [id, verdict] of Object.entries(result.verdicts)) {
      if (verdict === 'stale') expect(result.reasons[id], id).not.toBe('');
      else expect(result.reasons[id], id).toBe('');
    }
  });

  it('is deterministic', () => {
    const again = buildPeople(waitlistLines(), { runDate: RUN, appointments: sampleAppointments(), getReading });
    expect(again).toEqual(result);
  });
});
