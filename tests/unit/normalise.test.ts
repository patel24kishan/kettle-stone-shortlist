import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  formatPhone,
  lineDate,
  phoneDigits,
  shortDate,
  twoMonthCutoff,
} from '@/lib/normalise';

describe('lineDate', () => {
  it.each([
    ['Jul 6', '2026-07-06'],
    ['Sept 1', '2026-09-01'],
    ['Sep 1', '2026-09-01'],
    ['7/14', '2026-07-14'],
    ['10/19', '2026-10-19'],
    ['Aug 22', '2026-08-22'],
    ['  Oct 2 ', '2026-10-02'],
  ])('%s -> %s', (raw, iso) => {
    expect(lineDate(raw, 2026)).toBe(iso);
  });

  it('uses the run year', () => {
    expect(lineDate('Jul 6', 2027)).toBe('2027-07-06');
  });

  it('rejects things it cannot read', () => {
    expect(() => lineDate('someday', 2026)).toThrow(/Cannot read the date/);
    expect(() => lineDate('13/40', 2026)).toThrow(/Cannot read the date/);
    expect(() => lineDate('Foo 3', 2026)).toThrow(/Cannot read the date/);
  });
});

describe('phoneDigits / formatPhone', () => {
  it('keeps digits only', () => {
    expect(phoneDigits('506-555-0101')).toBe('5065550101');
    expect(phoneDigits('(506)555-0113')).toBe('5065550113');
    expect(phoneDigits('506 555 0102')).toBe('5065550102');
    expect(phoneDigits('5065550105')).toBe('5065550105');
  });

  it('returns null for "same #" in any case', () => {
    expect(phoneDigits('same #')).toBeNull();
    expect(phoneDigits('Same #')).toBeNull();
    expect(phoneDigits('SAME #')).toBeNull();
    expect(phoneDigits('')).toBeNull();
  });

  it('formats a 10 digit number', () => {
    expect(formatPhone('5065550140')).toBe('(506) 555-0140');
    expect(formatPhone('15065550140')).toBe('(506) 555-0140');
  });

  it('leaves odd lengths alone', () => {
    expect(formatPhone('5550140')).toBe('5550140');
    expect(formatPhone('')).toBe('');
  });
});

describe('canonicalName', () => {
  it('lowercases, removes accents and collapses spaces', () => {
    expect(canonicalName('  Joël   BERTIN ')).toBe('joel bertin');
    expect(canonicalName('Hélène Surette')).toBe('helene surette');
  });

  it('expands first-name nicknames', () => {
    expect(canonicalName('Mel Arsenault')).toBe('melanie arsenault');
    expect(canonicalName('Jen LeBlanc')).toBe('jennifer leblanc');
    expect(canonicalName('Bob Gaudet')).toBe('robert gaudet');
    expect(canonicalName('Steph Poirier')).toBe('stephanie poirier');
  });

  it('only expands the first name', () => {
    expect(canonicalName('Anne Mel')).toBe('anne mel');
  });

  it('makes a nickname equal to the full name', () => {
    expect(canonicalName('Jen LeBlanc')).toBe(canonicalName('Jennifer Leblanc'));
  });
});

describe('twoMonthCutoff', () => {
  it('Oct 21 -> Aug 21', () => {
    expect(twoMonthCutoff('2026-10-21')).toBe('2026-08-21');
  });

  it('clamps month ends', () => {
    expect(twoMonthCutoff('2026-12-31')).toBe('2026-10-31');
    expect(twoMonthCutoff('2026-10-31')).toBe('2026-08-31');
    expect(twoMonthCutoff('2026-04-30')).toBe('2026-02-28');
    expect(twoMonthCutoff('2028-04-30')).toBe('2028-02-29');
    expect(twoMonthCutoff('2026-05-31')).toBe('2026-03-31');
  });

  it('crosses the year', () => {
    expect(twoMonthCutoff('2026-01-15')).toBe('2025-11-15');
    expect(twoMonthCutoff('2026-02-28')).toBe('2025-12-28');
  });

  it('rejects a bad date', () => {
    expect(() => twoMonthCutoff('Oct 21')).toThrow();
  });
});

describe('shortDate', () => {
  it('formats for reason text', () => {
    expect(shortDate('2026-08-11')).toBe('Aug 11');
    expect(shortDate('2026-09-01')).toBe('Sep 1');
  });
});
