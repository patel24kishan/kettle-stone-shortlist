// The one pipeline every entry point uses (CLI now; API and screens later). build-plan.md section 6 Step 4.
// Raw CSV text in -> column check -> parse -> group -> readAll (saved readings / Claude) -> buildPeople
// -> matchAll -> results. Pure apart from the reading cache and the optional Claude client: no file or
// console access here, so the same function serves the CLI, the API routes and the tests.
// rules.md "Always": same files in, same names out; test runs start with no Booked marks (booked = []);
// never notes or health details (nothing here returns note text).
import type Anthropic from '@anthropic-ai/sdk';
import { checkColumns, parseAppointments, parseOpenings, parseWaitlist } from '@/lib/csv';
import type { CsvKind } from '@/lib/csv';
import { buildPeople, groupLines } from '@/lib/import';
import { NO_SHOW_REASON, matchAll } from '@/lib/match';
import type { ReadingCache } from '@/lib/readings/cache';
import type { ReadingCallLog } from '@/lib/readings/claude';
import { makeGetReading, readAll } from '@/lib/readings/reader';
import type { ReadResult } from '@/lib/readings/reader';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { BookedRecord, LineVerdict, OpeningResult, Person, Settings, WaitlistLine } from '@/lib/types';

export interface RunInput {
  waitlistText: string;
  appointmentsText: string;
  openingsText: string;
  /** ISO date the waitlist is read for (sample: 2026-10-21). The run year is this date's year. */
  runDate: string;
  cache: ReadingCache;
  /** null = no Claude: people without a saved reading are "not read" and never offered. */
  client: Anthropic | null;
  /** Bookings made through the tool. Test runs and the CLI pass none. */
  booked?: BookedRecord[];
  settings?: Settings;
  log?: (entry: ReadingCallLog) => void;
}

export interface RunSummary {
  openings: number;
  withPeople: number;
  nobody: number;
  noShows: number;
  linesRead: number;
  /** People with no tag (not stale, not booked). */
  peopleActive: number;
  /** Lines whose verdict is stale. */
  stale: number;
  /** Lines merged into a newer line of the same person. */
  duplicates: number;
  /** Newest line ids of active people whose notes were not read (no saved reading and no Claude). Never offered. */
  notRead: string[];
  /** Newest line ids of active people whose Claude read failed. Never offered. */
  failed: string[];
}

export interface RunOutput {
  runDate: string;
  lines: WaitlistLine[];
  people: Person[];
  verdicts: Record<string, LineVerdict>;
  reasons: Record<string, string>;
  reads: Map<string, ReadResult>;
  results: OpeningResult[];
  summary: RunSummary;
}

export interface FileProblem {
  kind: CsvKind;
  missing: string[];
}

/** One error for all the files with missing columns. `problems` lets a caller name the files it was given. */
export class InputFilesError extends Error {
  constructor(readonly problems: FileProblem[]) {
    super(describeProblems(problems));
    this.name = 'InputFilesError';
  }
}

const KIND_LABEL: Record<string, string> = {
  waitlist: 'waitlist',
  appointments: 'appointments',
  openings: 'late openings',
  answerKey: 'answer key',
};

export function describeProblems(problems: FileProblem[], names: Partial<Record<CsvKind, string>> = {}): string {
  return problems
    .map((p) => {
      const label = KIND_LABEL[p.kind] ?? p.kind;
      const file = names[p.kind] ? ` (${names[p.kind]})` : '';
      return `The ${label} file${file} is missing column(s): ${p.missing.join(', ')}.`;
    })
    .join(' ');
}

/** Checks the three files' columns. Returns every problem, not just the first. */
export function checkInputs(input: Pick<RunInput, 'waitlistText' | 'appointmentsText' | 'openingsText'>): FileProblem[] {
  const problems: FileProblem[] = [];
  const files: [CsvKind, string][] = [
    ['waitlist', input.waitlistText],
    ['appointments', input.appointmentsText],
    ['openings', input.openingsText],
  ];
  for (const [kind, text] of files) {
    const check = checkColumns(text, kind);
    if (!check.ok) problems.push({ kind, missing: check.missing });
  }
  return problems;
}

export async function runShortlist(input: RunInput): Promise<RunOutput> {
  const problems = checkInputs(input);
  if (problems.length > 0) throw new InputFilesError(problems);

  const runYear = Number(input.runDate.slice(0, 4));
  const lines = parseWaitlist(input.waitlistText, runYear);
  const appointments = parseAppointments(input.appointmentsText);
  const openings = parseOpenings(input.openingsText);
  const settings = input.settings ?? DEFAULT_SETTINGS;

  const groups = groupLines(lines);
  const reads = await readAll(groups, { cache: input.cache, client: input.client, runYear, log: input.log });
  const built = buildPeople(lines, {
    runDate: input.runDate,
    appointments,
    getReading: makeGetReading(reads, groups),
    booked: input.booked ?? [],
  });
  const readings = new Map([...reads.entries()].map(([key, r]) => [key, r.reading]));
  const results = matchAll(openings, built.people, readings, settings);

  const verdictValues = Object.values(built.verdicts);
  // Only people who could have been offered matter for the warning: a tagged person is skipped anyway.
  const untagged = built.people.filter((p) => p.tags.length === 0);
  const statusOf = (p: Person) => reads.get(p.key)?.status;
  const withPeople = results.filter((r) => r.suggestions.length > 0).length;

  const summary: RunSummary = {
    openings: results.length,
    withPeople,
    nobody: results.length - withPeople,
    noShows: results.filter((r) => r.nobodyReason === NO_SHOW_REASON).length,
    linesRead: lines.length,
    peopleActive: untagged.length,
    stale: verdictValues.filter((v) => v === 'stale').length,
    duplicates: verdictValues.filter((v) => v.startsWith('duplicate of')).length,
    notRead: untagged.filter((p) => statusOf(p) === 'not read').map((p) => p.newestId),
    failed: untagged.filter((p) => statusOf(p) === 'failed').map((p) => p.newestId),
  };

  // An untagged person whose notes weren't read keeps their verdict (as Tanya's key words it) but the reason says
  // why they were never offered, so line_verdicts.csv doesn't read as a plain "active".
  const reasons = { ...built.reasons };
  for (const p of untagged) {
    const status = statusOf(p);
    if (status === 'not read') reasons[p.newestId] = 'Notes not read yet, so not offered.';
    if (status === 'failed') reasons[p.newestId] = 'Notes could not be read, so not offered.';
  }

  return {
    runDate: input.runDate,
    lines,
    people: built.people,
    verdicts: built.verdicts,
    reasons,
    reads,
    results,
    summary,
  };
}

// ---- hand-in files ----------------------------------------------------------------------------------------

/** One CSV field: quoted when it holds a comma, a quote or a line break; quotes are doubled. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const csvRow = (fields: string[]) => fields.map(csvField).join(',');

/** "(506) 555-0140" -> "506-555-0140". Anything that is not 10 digits (or 1 + 10) is returned unchanged. */
export function dashedPhone(display: string): string {
  const digits = display.replace(/\D/g, '');
  const d = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (d.length !== 10) return display;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** `opening_id,shortlist`; shortlist is `W46 Shawn Duguay (506-555-0140); W53 Luc Bernard (506-555-0121)` or `none`. */
export function resultsCsv(results: OpeningResult[]): string {
  const rows = results.map((r) => {
    const shortlist =
      r.suggestions.length === 0
        ? 'none'
        : r.suggestions.map((s) => `${s.lineId} ${s.name} (${dashedPhone(s.phoneDisplay)})`).join('; ');
    return csvRow([r.openingId, shortlist]);
  });
  return `${['opening_id,shortlist', ...rows].join('\n')}\n`;
}

/** `line,verdict,reason`, one row per waitlist line in line order (W01 ... W60). */
export function lineVerdictsCsv(
  lines: WaitlistLine[],
  verdicts: Record<string, LineVerdict>,
  reasons: Record<string, string>,
): string {
  const rows = [...lines]
    .sort((a, b) => a.n - b.n)
    .map((l) => csvRow([l.id, verdicts[l.id] ?? '', reasons[l.id] ?? '']));
  return `${['line,verdict,reason', ...rows].join('\n')}\n`;
}
