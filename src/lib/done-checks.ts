// The pieces `npm run check:done` (scripts/check-done.ts) is built from: the build plan's section 7 done checks.
// Pure functions, no I/O, so each can be tested on its own (tests/unit/check-done.test.ts).
import Papa from 'papaparse';
import { parseCsv } from '@/lib/csv';

// ---- the printed checklist ---------------------------------------------------------------------------------

export interface DoneItem {
  ok: boolean;
  title: string;
  /** What was seen, in a line or a few. */
  evidence: string[];
}

export function formatItem(item: DoneItem): string {
  const [first = '', ...rest] = item.evidence;
  const head = `${item.ok ? '✅' : '❌'} ${item.title}${first ? ` — ${first}` : ''}`;
  return [head, ...rest.map((e) => `     ${e}`)].join('\n');
}

export function formatSummary(items: DoneItem[]): string {
  const failed = items.filter((i) => !i.ok);
  return failed.length === 0
    ? `All ${items.length} checks passed.`
    : `${failed.length} of ${items.length} checks failed: ${failed.map((i) => i.title).join('; ')}.`;
}

// ---- no health detail in any output ------------------------------------------------------------------------

/** The words the plan says to search outputs for (build-plan section 7), plus "pregnancy". */
export const HEALTH_SCAN_WORDS = [
  'pregnant', 'pregnancy', 'surgery', 'post-op', 'MVA', 'sciatica', 'cancer', 'fibro', 'concussion', 'migraine', 'TMJ',
] as const;

const HEALTH_SCAN_RE = new RegExp(
  `(?<![a-z0-9])(${HEALTH_SCAN_WORDS.map((w) => w.toLowerCase().replace(/-/g, '\\-')).join('|')})s?(?![a-z0-9])`,
  'gi',
);

/** Every health word in `text` (whole words, any case, plural "s" included), lower-cased, unique. */
export function findHealthWords(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(HEALTH_SCAN_RE)) found.add(m[1]!.toLowerCase());
  return [...found];
}

const squash = (s: string): string => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Notes shorter than this are left out of the full-note search: "any" or "60" would match ordinary text. */
export const MIN_NOTE_LENGTH = 8;

/**
 * The waitlist notes that appear in full in `text` (case and spacing ignored; also as CSV- or JSON-escaped text).
 * Notes shorter than MIN_NOTE_LENGTH are skipped.
 */
export function findFullNotes(text: string, notes: readonly string[]): string[] {
  const hay = squash(text);
  const found: string[] = [];
  for (const note of new Set(notes.map((n) => n.trim()))) {
    if (note.length < MIN_NOTE_LENGTH) continue;
    const forms = [note, note.replace(/"/g, '""'), JSON.stringify(note).slice(1, -1)].map(squash);
    if (forms.some((f) => hay.includes(f))) found.push(note);
  }
  return found;
}

export interface ScannedFile {
  name: string;
  text: string;
}

export interface ScanResult {
  files: number;
  /** "results.csv: surgery" or "run.json: full note on a waitlist line". */
  problems: string[];
}

/** Scans every file for health words and full notes. Problems never quote the notes themselves. */
export function scanForHealthDetail(files: readonly ScannedFile[], notes: readonly string[]): ScanResult {
  const problems: string[] = [];
  for (const f of files) {
    const words = findHealthWords(f.text);
    if (words.length > 0) problems.push(`${f.name}: ${words.join(', ')}`);
    const full = findFullNotes(f.text, notes);
    if (full.length > 0) problems.push(`${f.name}: ${full.length} full waitlist note${full.length === 1 ? '' : 's'}`);
  }
  return { files: files.length, problems };
}

/** The notes column of a waitlist CSV. */
export function waitlistNotes(waitlistText: string): string[] {
  return parseCsv(waitlistText).map((r) => r.notes ?? '');
}

// ---- results.csv ------------------------------------------------------------------------------------------

/** opening_id -> line ids shown, in order ([] = nobody). */
export function shortlistIds(resultsText: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of parseCsv(resultsText)) {
    const s = (r.shortlist ?? '').trim();
    out.set(r.opening_id ?? '', s === '' || s === 'none' ? [] : s.split('; ').map((x) => x.split(' ')[0]!));
  }
  return out;
}

/** opening_id -> the shortlist text as written. */
function shortlistText(resultsText: string): Map<string, string> {
  return new Map(parseCsv(resultsText).map((r) => [r.opening_id ?? '', r.shortlist ?? '']));
}

/** Openings whose names differ between two results.csv texts (or that only one of them has). */
export function differingOpenings(a: string, b: string): string[] {
  const [x, y] = [shortlistText(a), shortlistText(b)];
  const ids = [...new Set([...x.keys(), ...y.keys()])];
  return ids.filter((id) => x.get(id) !== y.get(id));
}

/** The no-show openings of a late openings CSV. */
export function noShowIds(openingsText: string): string[] {
  return parseCsv(openingsText)
    .filter((r) => (r.kind ?? '').trim().toLowerCase() === 'no-show')
    .map((r) => r.opening_id ?? '');
}

/** Of `ids`, those that results.csv does not show as nobody (missing counts as not nobody). */
export function notNobody(resultsText: string, ids: readonly string[]): string[] {
  const rows = shortlistIds(resultsText);
  return ids.filter((id) => rows.get(id)?.length !== 0);
}

// ---- README ------------------------------------------------------------------------------------------------

/** What a README must mention for someone else to set up and run the tool. */
export const README_MUST_MENTION = [
  'npm install',
  'npm run dev',
  'npm run shortlist -- run',
  'npm run shortlist -- score',
  'npm run check:done',
  'npm test',
] as const;

export function readmeMissing(text: string): string[] {
  return README_MUST_MENTION.filter((p) => !text.includes(p));
}

// ---- the Friday-style rehearsal ----------------------------------------------------------------------------

/** Two lines appended to the sample waitlist, as Tanya would type them: a new person, and a repeat line. */
export const REHEARSAL_EXTRA_LINES = [
  '61,10/24,Odile Comeau,506-555-0199,any - 60 - not Mon',
  '62,10/24,Andrea P.,same #,still wants in - same as before',
];

/** The sample waitlist plus the two lines (CRLF, like the sample file). */
export function rehearsalWaitlist(sampleWaitlistText: string): string {
  const base = sampleWaitlistText.endsWith('\n') ? sampleWaitlistText : `${sampleWaitlistText}\r\n`;
  return base + REHEARSAL_EXTRA_LINES.map((l) => `${l}\r\n`).join('');
}

export const REHEARSAL_RUN_DATE = '2026-10-26';

const OPENING_COLUMNS = [
  'opening_id', 'appointment_id', 'date', 'day', 'start', 'length_min', 'therapist', 'kind', 'cancelled_at',
  'hours_notice', 'heard_via', 'client_had_confirmed', 'refilled', 'refilled_how', 'booked_value_cad',
];

/** Ten new late openings, Mon Oct 26 to Sat Oct 31: two no-shows, one Josée, one 90-min, one 1-hour notice. */
const REHEARSAL_OPENINGS: string[][] = [
  ['O01', 'A-25004', '2026-10-26', 'Mon', '10:00', '60', 'Dave Melanson', 'late cancel', '2026-10-26 06:42', '3.3', 'voicemail (overnight)', 'yes (text)', 'no', '', '115'],
  ['O02', 'A-25013', '2026-10-26', 'Mon', '14:00', '60', 'Amira Haddad', 'no-show', '2026-10-26 14:15', '0.0', 'no-show', 'no', 'no', '', '115'],
  ['O03', 'A-25031', '2026-10-27', 'Tue', '11:00', '90', 'Kelsey Babineau', 'late cancel', '2026-10-27 07:30', '3.5', 'voicemail (overnight)', 'yes (text)', 'no', '', '160'],
  ['O04', 'A-25042', '2026-10-27', 'Tue', '17:00', '60', 'Rachel Thibodeau', 'late cancel', '2026-10-27 16:00', '1.0', 'phone', 'yes (phone)', 'no', '', '115'],
  ['O05', 'A-25056', '2026-10-28', 'Wed', '11:15', '60', 'Amira Haddad', 'late cancel', '2026-10-28 08:05', '3.2', 'morning call', 'yes (text)', 'no', '', '115'],
  ['O06', 'A-25067', '2026-10-29', 'Thu', '16:30', '60', 'Dave Melanson', 'late cancel', '2026-10-29 12:00', '4.5', 'text reply', 'yes (text)', 'no', '', '115'],
  ['O07', 'A-25071', '2026-10-29', 'Thu', '12:00', '30', 'Marc Cormier', 'late cancel', '2026-10-29 08:30', '3.5', 'online (Kneadly)', 'no', 'no', '', '70'],
  ['O08', 'A-25083', '2026-10-30', 'Fri', '15:00', '60', 'Kelsey Babineau', 'no-show', '2026-10-30 15:15', '0.0', 'no-show', 'yes (text)', 'no', '', '115'],
  ['O09', 'A-25090', '2026-10-30', 'Fri', '18:00', '60', 'Rachel Thibodeau', 'late cancel', '2026-10-30 11:20', '6.7', 'phone', 'yes (text)', 'no', '', '115'],
  ['O10', 'A-25102', '2026-10-31', 'Sat', '13:00', '60', 'Josée Landry', 'late cancel', '2026-10-31 10:30', '2.5', 'morning call', 'yes (text)', 'no', '', '115'],
];

export function rehearsalOpeningsCsv(): string {
  const rows = REHEARSAL_OPENINGS.map((o) => Object.fromEntries(OPENING_COLUMNS.map((c, i) => [c, o[i]!])));
  return `${Papa.unparse(rows, { columns: OPENING_COLUMNS, newline: '\r\n' })}\r\n`;
}
