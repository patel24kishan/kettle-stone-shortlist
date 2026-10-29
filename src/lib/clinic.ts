// The clinic's time zone: one setting for the whole app (BUILD_PROGRESS A6).
// File times (openings, waitlist, booking export) are used as written and never converted. Only the app's own
// clock is turned into the clinic's local day: the Booked timestamp, "today", and "cancelled at: now", because a
// hosted server runs in UTC.
//
// Set CLINIC_TIME_ZONE (an IANA name such as America/Halifax) in .env.local or on Vercel to change it. Empty or
// not a real time zone -> America/Moncton (New Brunswick), with a warning, never a crash.
// next.config.ts copies CLINIC_TIME_ZONE into the build (`env`), so the browser screens use the same zone as the
// server. Change it, then restart `npm run dev` or run `npm run build` again.
export const DEFAULT_CLINIC_TIME_ZONE = 'America/Moncton';

/** `value` when it is a time zone this runtime knows, else the default. */
export function resolveTimeZone(value: string | undefined | null): string {
  const zone = (value ?? '').trim();
  if (!zone) return DEFAULT_CLINIC_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return zone;
  } catch {
    console.warn(`CLINIC_TIME_ZONE "${zone}" is not a time zone; using ${DEFAULT_CLINIC_TIME_ZONE}.`);
    return DEFAULT_CLINIC_TIME_ZONE;
  }
}

// Read with the literal name so Next can put the value into the browser code at build time.
export const CLINIC_TIME_ZONE: string = resolveTimeZone(process.env.CLINIC_TIME_ZONE);
