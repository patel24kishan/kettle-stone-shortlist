// Small, pure clean-up helpers for the import step (rules.md Step 1; build-plan 3 and 5.2).

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** First-name nicknames seen in the waitlist and the booking export (build-plan 5.3 item 4). */
const NICKNAMES: Record<string, string> = {
  mel: 'melanie',
  jen: 'jennifer',
  bob: 'robert',
  steph: 'stephanie',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(year: number, month: number, day: number, raw: string): string {
  if (
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)
  ) {
    throw new Error(`Cannot read the date "${raw}".`);
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** "Jul 6", "Sept 1", "Sep 1", "7/14", "10/19" -> ISO date in the run year. */
export function lineDate(raw: string, year: number): string {
  const s = raw.trim();
  let m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) return toIso(year, Number(m[1]), Number(m[2]), raw);
  m = /^([A-Za-z]+)\.?\s+(\d{1,2})$/.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month === undefined) throw new Error(`Cannot read the date "${raw}".`);
    return toIso(year, month, Number(m[2]), raw);
  }
  throw new Error(`Cannot read the date "${raw}".`);
}

/** Digits only, or null for "same #" (the number is on an earlier line). */
export function phoneDigits(raw: string): string | null {
  const s = raw.trim();
  if (/^same\s*#?$/i.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  return digits === '' ? null : digits;
}

/** "5065550140" -> "(506) 555-0140". Anything that is not 10 digits (or 1 + 10) is returned unchanged. */
export function formatPhone(digits: string): string {
  const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^\d{10}$/.test(d)) return digits;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Lowercase, accents removed, single spaces, first-name nickname expanded. */
export function canonicalName(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 0) words[0] = NICKNAMES[words[0]!] ?? words[0]!;
  return words.join(' ');
}

/** Two calendar months before the run date, clamped to the month end (rules.md Step 2). */
export function twoMonthCutoff(runDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(runDate);
  if (!m) throw new Error(`Cannot read the run date "${runDate}" (expected yyyy-mm-dd).`);
  let year = Number(m[1]);
  let month = Number(m[2]) - 2;
  const day = Number(m[3]);
  if (month < 1) {
    month += 12;
    year -= 1;
  }
  return `${year}-${pad2(month)}-${pad2(Math.min(day, daysInMonth(year, month)))}`;
}

/** ISO date -> "Aug 11" for reason text. */
export function shortDate(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTH_ABBR[Number(m[1]) - 1] ?? m[1]} ${Number(m[2])}`;
}
