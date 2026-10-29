// The one clinic time-zone setting (src/lib/clinic.ts, BUILD_PROGRESS A6).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CLINIC_TIME_ZONE, resolveTimeZone } from '@/lib/clinic';

const saved = process.env.CLINIC_TIME_ZONE;
afterEach(() => {
  if (saved === undefined) delete process.env.CLINIC_TIME_ZONE;
  else process.env.CLINIC_TIME_ZONE = saved;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('resolveTimeZone', () => {
  it('empty or missing -> America/Moncton', () => {
    expect(DEFAULT_CLINIC_TIME_ZONE).toBe('America/Moncton');
    expect(resolveTimeZone(undefined)).toBe('America/Moncton');
    expect(resolveTimeZone('')).toBe('America/Moncton');
    expect(resolveTimeZone('   ')).toBe('America/Moncton');
  });

  it('a real time zone is used as given (trimmed)', () => {
    expect(resolveTimeZone('America/Halifax')).toBe('America/Halifax');
    expect(resolveTimeZone(' America/Toronto ')).toBe('America/Toronto');
  });

  it('not a time zone -> the default with a warning, never a crash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveTimeZone('Moncton')).toBe('America/Moncton');
    expect(resolveTimeZone('Mars/Olympus_Mons')).toBe('America/Moncton');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('CLINIC_TIME_ZONE drives the app clock', () => {
  // 00:30 UTC on Oct 20 = 9:30 PM Oct 19 in New Brunswick, = 8:30 PM Oct 19 in Toronto, still Oct 20 in Paris.
  const at = new Date('2026-10-20T00:30:00.000Z');

  it('default: the New Brunswick day and clock (unchanged behaviour)', async () => {
    delete process.env.CLINIC_TIME_ZONE;
    vi.resetModules();
    const { todayIso, timestampText } = await import('@/lib/format');
    const { clinicNowLocal } = await import('@/lib/search-view');
    expect(todayIso(at)).toBe('2026-10-19');
    expect(timestampText(at.toISOString())).toBe('Oct 19, 9:30 PM');
    expect(clinicNowLocal(at)).toBe('2026-10-19T21:30');
  });

  it('set: the screens and the booked-since day follow the setting', async () => {
    process.env.CLINIC_TIME_ZONE = 'Europe/Paris';
    vi.resetModules();
    const { CLINIC_TIME_ZONE } = await import('@/lib/clinic');
    const { todayIso, timestampText } = await import('@/lib/format');
    expect(CLINIC_TIME_ZONE).toBe('Europe/Paris');
    expect(todayIso(at)).toBe('2026-10-20');
    expect(timestampText(at.toISOString())).toBe('Oct 20, 2:30 AM');
    // An explicit zone argument still wins (signatures unchanged).
    expect(todayIso(at, 'America/Moncton')).toBe('2026-10-19');
  });

  it('invalid: falls back to the default', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CLINIC_TIME_ZONE = 'not/a-zone';
    vi.resetModules();
    const { CLINIC_TIME_ZONE } = await import('@/lib/clinic');
    expect(CLINIC_TIME_ZONE).toBe('America/Moncton');
  });
});
