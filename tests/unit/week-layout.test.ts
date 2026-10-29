import { describe, expect, it } from 'vitest';
import {
  GRID_END_MIN,
  GRID_HEIGHT,
  blockFor,
  columnsFor,
  daySummary,
  formatTime,
  hourLabels,
  rowsForColumn,
  toMinutes,
} from '@/lib/week/layout';
import { SAMPLE_WEEK, THERAPISTS, WEEK_DAYS } from '@/lib/week/sample-week';
import type { WeekRow, WeekStatus } from '@/lib/week/sample-week';

const row = (start: string, end: string, status: WeekStatus = 'Completed') => ({ start, end, status });
const dayRows = (iso: string) => SAMPLE_WEEK.filter((r) => r.day === iso);
const THU = '2026-10-15';

describe('blockFor (88 px per hour from 9:00)', () => {
  it('9:00 to 10:00 is top 2, height 84', () => {
    const b = blockFor(row('09:00', '10:00'));
    expect(b.top).toBe(2);
    expect(b.height).toBe(84);
    expect(b.label).toBe('9:00 AM to 10:00 AM');
  });

  it('11:15 to 12:15', () => {
    const b = blockFor(row('11:15', '12:15'));
    expect(b.top).toBe((135 / 60) * 88 + 2);
    expect(b.height).toBe(84);
    expect(b.label).toBe('11:15 AM to 12:15 PM');
  });

  it('16:30 to 18:00', () => {
    const b = blockFor(row('16:30', '18:00'));
    expect(b.top).toBe((450 / 60) * 88 + 2);
    expect(b.top).toBe(662);
    expect(b.height).toBe(1.5 * 88 - 4);
    expect(b.label).toBe('4:30 PM to 6:00 PM');
  });

  it('labels carry the status in words', () => {
    expect(blockFor(row('11:15', '12:15', 'Completed')).label).toBe('11:15 AM to 12:15 PM');
    expect(blockFor(row('11:15', '12:15', 'Late cancel')).label).toBe('Late cancel · open · 11:15 AM to 12:15 PM');
    expect(blockFor(row('11:00', '12:00', 'No-show')).label).toBe('No-show · 11:00 AM to 12:00 PM');
    expect(blockFor(row('10:15', '10:45', 'Cancelled')).label).toBe('Cancelled ahead · 10:15 AM to 10:45 AM');
    expect(blockFor(row('12:00', '13:00', 'Refilled')).label).toBe('Refilled · 12:00 PM to 1:00 PM');
  });

  it('uses the mockup colours per status', () => {
    expect(blockFor(row('09:00', '10:00', 'Completed')).style.background).toBe('#E6F4F1');
    expect(blockFor(row('09:00', '10:00', 'Late cancel')).style.border).toBe('2px dashed #C2410C');
    expect(blockFor(row('09:00', '10:00', 'No-show')).style.background).toBe('#FDE2E4');
    expect(blockFor(row('09:00', '10:00', 'Cancelled')).style.border).toBe('1px dashed #6B7280');
    expect(blockFor(row('09:00', '10:00', 'Refilled')).style).toMatchObject({ background: '#FFFFFF', border: '2px solid #0F766E' });
  });
});

describe('time and hour helpers', () => {
  it('formats 12-hour times', () => {
    expect(formatTime('00:05')).toBe('12:05 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
    expect(formatTime('19:45')).toBe('7:45 PM');
  });

  it('hour labels run 9:00 AM to 7:00 PM, 88 px apart', () => {
    const h = hourLabels();
    expect(h).toHaveLength(11);
    expect(h[0]).toEqual({ top: 2, label: '9:00 AM' });
    expect(h[3]).toEqual({ top: 3 * 88 - 8, label: '12:00 PM' });
    expect(h[10].label).toBe('7:00 PM');
    expect(GRID_HEIGHT).toBe(946);
  });
});

describe('Thursday is the mockup week (25 rows)', () => {
  const thu = dayRows(THU);

  it('has 25 rows and the four mockup therapists', () => {
    expect(thu).toHaveLength(25);
    expect(columnsFor(THU, SAMPLE_WEEK)).toEqual(['Dave Melanson', 'Josée Landry', 'Marc Cormier', 'Rachel Thibodeau']);
  });

  it('contains specific mockup rows', () => {
    const has = (therapist: string, start: string, end: string, client: string, status: WeekStatus) =>
      expect(thu).toContainEqual({ day: THU, therapist, start, end, client, status });
    has('Marc Cormier', '11:15', '12:15', 'Roger Gould', 'Late cancel');
    has('Dave Melanson', '12:15', '13:45', "Francine O'Neill", 'Completed');
    has('Rachel Thibodeau', '19:00', '19:30', 'Dominique Caissy', 'Completed');
    has('Josée Landry', '10:15', '10:45', 'Eric Belanger', 'Cancelled');
  });

  it('summary matches the mockup header', () => {
    expect(daySummary(thu)).toBe('25 appointments · 4 late openings · 0 refilled');
  });
});

describe('every day of the sample week', () => {
  it('covers Mon Oct 12 to Sat Oct 17', () => {
    expect(WEEK_DAYS.map((d) => d.iso)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
    expect(WEEK_DAYS.map((d) => d.tab)[0]).toBe('Mon, Oct 12');
    expect(new Set(SAMPLE_WEEK.map((r) => r.day))).toEqual(new Set(WEEK_DAYS.map((d) => d.iso)));
  });

  for (const { iso, tab } of WEEK_DAYS) {
    describe(tab, () => {
      const rows = dayRows(iso);

      it('has 4 to 6 therapists, all from the clinic', () => {
        const cols = columnsFor(iso, SAMPLE_WEEK);
        expect(cols.length).toBeGreaterThanOrEqual(4);
        expect(cols.length).toBeLessThanOrEqual(6);
        for (const c of cols) expect(THERAPISTS as readonly string[]).toContain(c);
        expect(new Set(rows.map((r) => r.therapist)).size).toBe(cols.length);
      });

      it('keeps every block within 9:00 and 19:45, with the end after the start', () => {
        for (const r of rows) {
          expect(toMinutes(r.start)).toBeGreaterThanOrEqual(9 * 60);
          expect(toMinutes(r.end)).toBeLessThanOrEqual(GRID_END_MIN);
          expect(toMinutes(r.end)).toBeGreaterThan(toMinutes(r.start));
        }
      });

      it('has no overlapping blocks in a column', () => {
        for (const t of columnsFor(iso, SAMPLE_WEEK)) {
          const col = rowsForColumn(iso, t, SAMPLE_WEEK);
          for (let i = 1; i < col.length; i++) {
            expect(toMinutes(col[i].start)).toBeGreaterThanOrEqual(toMinutes(col[i - 1].end));
          }
        }
      });

      it('shows the status in words in every block label', () => {
        for (const r of rows) {
          const label = blockFor(r).label;
          if (r.status === 'Completed') expect(label).toMatch(/^\d{1,2}:\d{2} (AM|PM) to \d{1,2}:\d{2} (AM|PM)$/);
          else if (r.status === 'Late cancel') expect(label).toMatch(/^Late cancel · open · /);
          else if (r.status === 'No-show') expect(label).toMatch(/^No-show · /);
          else if (r.status === 'Cancelled') expect(label).toMatch(/^Cancelled ahead · /);
          else expect(label).toMatch(/^Refilled · /);
        }
      });

      it('summary is computed from the data', () => {
        const late = rows.filter((r) => r.status === 'Late cancel' || r.status === 'No-show').length;
        const refilled = rows.filter((r) => r.status === 'Refilled').length;
        expect(daySummary(rows)).toBe(`${rows.length} appointments · ${late} late openings · ${refilled} refilled`);
      });
    });
  }

  it('Monday to Wednesday, Friday and Saturday each have a Refilled block; Thursday has none', () => {
    for (const d of WEEK_DAYS) {
      const n = dayRows(d.iso).filter((r) => r.status === 'Refilled').length;
      if (d.iso === THU) expect(n).toBe(0);
      else expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it('uses all five statuses across the week', () => {
    expect(new Set(SAMPLE_WEEK.map((r) => r.status))).toEqual(new Set(['Completed', 'Refilled', 'Late cancel', 'No-show', 'Cancelled']));
  });
});

describe('privacy of the sample data', () => {
  it('has only the typed fields and no health words', () => {
    const keys = ['day', 'therapist', 'start', 'end', 'client', 'status'].sort();
    const health = /pregnan|surgery|post-?op|\bMVA\b|sciatica|cancer|fibro|concussion|migraine|\bTMJ\b/i;
    for (const r of SAMPLE_WEEK as readonly WeekRow[]) {
      expect(Object.keys(r).sort()).toEqual(keys);
      expect(JSON.stringify(r)).not.toMatch(health);
      expect(r.client).toMatch(/^\p{L}[\p{L}'’-]*( \p{L}[\p{L}'’-]*)+$/u);
    }
  });
});
