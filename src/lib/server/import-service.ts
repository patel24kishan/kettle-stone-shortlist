// B5 "Import and analyse" (build-plan section 6, Admin). Column-check all three files; on a problem, say which
// file and column and save nothing. Otherwise run the one pipeline (Claude reads only people with no cached
// reading, and only when a client is given), save the import, and return what B5 shows.
// Server only.
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { checkColumns, parseAppointments } from '@/lib/csv';
import { InputFilesError, checkInputs, describeProblems, runShortlist } from '@/lib/run';
import type { FileProblem, RunOutput } from '@/lib/run';
import type { InputKind, Store, StoredFile, StoredImport } from '@/lib/storage/types';
import { INPUT_KINDS, adminView, fileCheckText, importInfo } from '@/lib/server/views';
import type { AdminView, FileCheck, ImportInfo } from '@/lib/server/views';

export interface InputFile {
  name: string;
  text: string;
}

export interface ImportInput {
  waitlist: InputFile;
  openings: InputFile;
  appointments: InputFile;
  /** YYYY-MM-DD */
  runDate: string;
}

export interface ImportDeps {
  store: Store;
  client: Anthropic | null;
  now?: () => Date;
}

export type ImportResult =
  | { ok: true; import: ImportInfo; view: AdminView }
  | { ok: false; message: string; problems: FileProblem[]; files: FileCheck[] };

export function isRealIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Each file's column check, in B5 order. */
export function checkFiles(input: Omit<ImportInput, 'runDate'>): FileCheck[] {
  return INPUT_KINDS.map((kind) => {
    const c = checkColumns(stripBom(input[kind].text), kind);
    return { kind, name: input[kind].name, ok: c.ok, rows: c.rows, missing: c.missing, check: fileCheckText(kind, c.rows, c.missing) };
  });
}

/** Date part of the latest `booked_at` in the booking export: how current "booked since" is. */
export function bookingExportDate(appointmentsText: string): string | null {
  let latest: string | null = null;
  for (const a of parseAppointments(stripBom(appointmentsText))) {
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(a.booked_at.trim())?.[1];
    if (day && (latest === null || day > latest)) latest = day;
  }
  return latest;
}

let lastId = '';
/** Sortable and unique in this process: "20261029T180714454Z-3f9a". */
function newImportId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  let id: string;
  do id = `${stamp}-${Math.random().toString(16).slice(2, 6).padEnd(4, '0')}`;
  while (id === lastId);
  lastId = id;
  return id;
}

export async function importFiles(input: ImportInput, deps: ImportDeps): Promise<ImportResult> {
  const files = checkFiles(input);
  const texts = {
    waitlistText: stripBom(input.waitlist.text),
    openingsText: stripBom(input.openings.text),
    appointmentsText: stripBom(input.appointments.text),
  };
  const names = { waitlist: input.waitlist.name, openings: input.openings.name, appointments: input.appointments.name };

  const problems = checkInputs(texts);
  if (problems.length > 0) return { ok: false, message: describeProblems(problems, names), problems, files };
  if (!isRealIsoDate(input.runDate)) {
    return { ok: false, message: `The run date must be a real date written YYYY-MM-DD (got "${input.runDate}").`, problems: [], files };
  }

  let run: RunOutput;
  let exportDate: string | null;
  try {
    exportDate = bookingExportDate(texts.appointmentsText);
    run = await runShortlist({
      ...texts,
      runDate: input.runDate,
      cache: deps.store.readingCache(),
      client: deps.client,
      booked: await deps.store.listBooked(), // Booked records survive a new import (build-plan section 4)
    });
  } catch (err) {
    if (err instanceof InputFilesError) {
      return { ok: false, message: describeProblems(err.problems, names), problems: err.problems, files };
    }
    // A value the parser could not use (an unknown therapist, a line number that is not a number, ...).
    return { ok: false, message: err instanceof Error ? err.message : String(err), problems: [], files };
  }

  const now = (deps.now ?? (() => new Date()))();
  const stored = (kind: InputKind): StoredFile => {
    const text = texts[`${kind}Text` as const];
    return { name: input[kind].name, sha256: sha256(text), text };
  };
  const imp: StoredImport = {
    id: newImportId(now),
    runDate: input.runDate,
    createdAt: now.toISOString(),
    files: { waitlist: stored('waitlist'), openings: stored('openings'), appointments: stored('appointments') },
    summary: {
      run: run.summary,
      bookingExportDate: exportDate,
      rows: Object.fromEntries(files.map((f) => [f.kind, f.rows])) as Record<InputKind, number>,
    },
  };
  await deps.store.saveImport(imp);

  return { ok: true, import: importInfo(imp), view: adminView(run, imp, { claudeConnected: deps.client !== null }) };
}
