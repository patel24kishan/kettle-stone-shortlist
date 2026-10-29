// The Search screen's server side (build-plan section 6 Step 6, Screens 1 and 2; section 4 "Keeping the backend
// in sync (Booked)"). Everything is matched against the current run (getCurrent: the latest import with today's
// Booked records, no Claude client), through the same matcher the CLI uses, so the screen and the CLI agree.
// Never calls Claude. rules.md "Always": only names, phones, line ids and openings leave this file.
// Server only.
import { checkColumns, parseOpenings } from '@/lib/csv';
import { fileCheckText } from '@/lib/input-files';
import { matchAll, matchOpening } from '@/lib/match';
import type { ReadingsByKey } from '@/lib/match';
import { describeProblems, resultsCsv } from '@/lib/run';
import type { FileProblem, RunOutput } from '@/lib/run';
import {
  alreadyFilledText,
  byDateOrder,
  checkOneInput,
  fileCounts,
  openingFromInput,
  openingView,
  queryOpeningId,
} from '@/lib/search-view';
import type { FileCounts, OneOpeningInput, OpeningView } from '@/lib/search-view';
import type { Store } from '@/lib/storage/types';
import { getCurrent } from '@/lib/server/current';
import type { CurrentState } from '@/lib/server/current';
import { adminView } from '@/lib/server/views';
import type { BookedRecord, Opening, Person } from '@/lib/types';

export const NO_IMPORT_MESSAGE = 'Nothing imported yet. Import the waitlist in Waitlist (admin) first.';

/** What the search screen says about the waitlist it matches against. */
export interface SearchContext {
  importId: string;
  /** ISO date the waitlist is read for. */
  runDate: string;
  /** Same count as B5's "People ready to match". */
  peopleReady: number;
  /** Latest booked_at date in the booking export, or null. */
  bookingExportDate: string | null;
  /** The late openings file of the latest import. */
  openingsFile: { name: string; rows: number; check: string };
  version: number;
}

export type Failure = { ok: false; status: 400 | 404 | 409; message: string; noImport?: true };

export type SearchOneResult = { ok: true; opening: OpeningView; context: SearchContext } | Failure;

export type SearchFileResult =
  | {
      ok: true;
      /** 'imported' = the late openings file of the latest import (no file chosen). */
      source: 'imported' | 'uploaded';
      fileName: string;
      /** "44 openings · columns OK" */
      check: string;
      openings: OpeningView[];
      counts: FileCounts;
      /** results.csv for these openings, exactly as the CLI writes it. */
      resultsCsv: string;
      context: SearchContext;
    }
  | (Failure & { problems: FileProblem[]; check?: string });

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const noImport = (): Failure => ({ ok: false, status: 409, message: NO_IMPORT_MESSAGE, noImport: true });

export function readingsOf(run: RunOutput): ReadingsByKey {
  return new Map([...run.reads.entries()].map(([key, r]) => [key, r.reading]));
}

export function searchContext(current: CurrentState): SearchContext {
  const { imp, run, version } = current;
  return {
    importId: imp.id,
    runDate: imp.runDate,
    peopleReady: adminView(run, imp).counts.peopleReady,
    bookingExportDate: imp.summary.bookingExportDate,
    openingsFile: {
      name: imp.files.openings.name,
      rows: imp.summary.rows.openings,
      check: fileCheckText('openings', imp.summary.rows.openings, []),
    },
    version,
  };
}

/** The search screen's context, or null before the first import. */
export async function getSearchContext(store: Store): Promise<SearchContext | null> {
  const current = await getCurrent(store);
  return current ? searchContext(current) : null;
}

export const bookedByOpening = (booked: BookedRecord[]) => new Map(booked.map((b) => [b.openingId, b]));

/** A1: one late opening typed in by Tanya. */
export async function searchOne(store: Store, input: Partial<Record<keyof OneOpeningInput, unknown>>): Promise<SearchOneResult> {
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const form: OneOpeningInput = {
    date: text(input.date),
    start: text(input.start),
    therapist: text(input.therapist),
    length: Number(text(input.length) || NaN),
    cancelledAt: text(input.cancelledAt),
  };
  const problems = checkOneInput(form);
  if (problems.length > 0) return { ok: false, status: 400, message: problems.join(' ') };
  const current = await getCurrent(store);
  if (!current) return noImport();

  // The same slot in the imported late openings file keeps that file's id, so a slot can only be booked once
  // whichever way it was searched. Otherwise the id comes from the slot: Q-20261015-1400-DM.
  const imported = parseOpenings(current.imp.files.openings.text).find(
    (o) => o.date === form.date && o.start === form.start && o.therapist === form.therapist,
  );
  const opening = openingFromInput(form, imported?.opening_id ?? queryOpeningId(form.date, form.start, form.therapist));
  const result = matchOpening(opening, current.run.people, readingsOf(current.run));
  const booked = bookedByOpening(current.booked).get(opening.opening_id) ?? null;
  return { ok: true, opening: openingView(opening, result, booked), context: searchContext(current) };
}

/** A1b "All openings from a file". `openingsText` null = the late openings file of the latest import. */
export async function searchFile(
  store: Store,
  openingsText: string | null,
  fileName?: string,
): Promise<SearchFileResult> {
  const uploaded = openingsText !== null;
  const text = uploaded ? stripBom(openingsText) : null;
  if (text !== null) {
    const check = checkColumns(text, 'openings');
    if (!check.ok) {
      const problems: FileProblem[] = [{ kind: 'openings', missing: check.missing }];
      return {
        ok: false,
        status: 400,
        message: describeProblems(problems, fileName ? { openings: fileName } : {}),
        problems,
        check: fileCheckText('openings', check.rows, check.missing),
      };
    }
  }

  const current = await getCurrent(store);
  if (!current) return { ...noImport(), problems: [] };

  const sourceText = text ?? current.imp.files.openings.text;
  let openings: Opening[];
  try {
    openings = byDateOrder(parseOpenings(sourceText));
  } catch (err) {
    return { ok: false, status: 400, message: err instanceof Error ? err.message : String(err), problems: [] };
  }

  const results = matchAll(openings, current.run.people, readingsOf(current.run));
  const booked = bookedByOpening(current.booked);
  const views = openings.map((o, i) => openingView(o, results[i]!, booked.get(o.opening_id) ?? null));
  return {
    ok: true,
    source: uploaded ? 'uploaded' : 'imported',
    fileName: uploaded ? (fileName ?? 'openings.csv') : current.imp.files.openings.name,
    check: fileCheckText('openings', openings.length, []),
    openings: views,
    counts: fileCounts(views),
    resultsCsv: resultsCsv(results),
    context: searchContext(current),
  };
}

// ---- Booked ---------------------------------------------------------------------------------------------

export interface BookInput {
  openingId: string;
  lineId: string;
  /** Which staff login marked it (Supabase mode, from the proxy). Default "local". */
  by?: string;
}

export type BookResult =
  | { ok: true; status: 200; record: BookedRecord; version: number }
  | { ok: false; status: 409; message: string; existing: BookedRecord }
  | Failure;

const OPENING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LINE_ID_RE = /^W\d{1,4}$/;

/** A person the search could suggest right now: no stale or booked tag, notes read, nothing unclear. */
function eligible(person: Person, run: RunOutput): boolean {
  if (person.tags.length > 0) return false;
  const read = run.reads.get(person.key);
  if (!read || !read.reading || read.status === 'not read' || read.status === 'failed') return false;
  return read.reading.unclear.length === 0;
}

/**
 * Booked (build-plan section 4): save first, then show. One booking per opening: a second one is refused with
 * the booking that is already there, and nothing is saved.
 */
export async function bookOpening(
  store: Store,
  input: Partial<BookInput>,
  now: () => Date = () => new Date(),
): Promise<BookResult> {
  const openingId = String(input.openingId ?? '').trim();
  const lineId = String(input.lineId ?? '').trim().toUpperCase();
  if (!OPENING_ID_RE.test(openingId)) return { ok: false, status: 400, message: 'Say which opening was booked.' };
  if (!LINE_ID_RE.test(lineId)) return { ok: false, status: 400, message: 'Say which waitlist line was booked (like W42).' };

  const current = await getCurrent(store);
  if (!current) return noImport();

  const existing = current.booked.find((b) => b.openingId === openingId);
  if (existing) return { ok: false, status: 409, message: alreadyFilledText(existing), existing };

  const person = current.run.people.find((p) => p.newestId === lineId);
  if (!person || !eligible(person, current.run)) {
    return {
      ok: false,
      status: 404,
      message: `Line ${lineId} is not someone the search can suggest right now. Search again to see who fits.`,
    };
  }

  const record: BookedRecord = {
    personPhoneDigits: person.phoneDigits,
    personName: person.name,
    lineId: person.newestId,
    openingId,
    at: now().toISOString(),
    by: input.by?.trim() || 'local',
  };
  const saved = await store.addBooked(record);
  if (!saved.ok) {
    const message =
      saved.existing.openingId === openingId
        ? alreadyFilledText(saved.existing)
        : `${saved.existing.personName} was just booked for ${saved.existing.openingId}.`;
    return { ok: false, status: 409, message, existing: saved.existing };
  }
  return { ok: true, status: 200, record, version: await store.version() };
}

export type UndoResult = { ok: true; status: 200; version: number } | Failure;

/** Undo a Booked mark: the person is suggested again everywhere. */
export async function undoBooked(store: Store, openingIdRaw: string | null): Promise<UndoResult> {
  const openingId = String(openingIdRaw ?? '').trim();
  if (!OPENING_ID_RE.test(openingId)) return { ok: false, status: 400, message: 'Say which opening to undo.' };
  if (!(await store.latestImport())) return noImport();
  const removed = await store.removeBooked(openingId);
  if (!removed) return { ok: false, status: 404, message: `${openingId} has no booking to undo.` };
  return { ok: true, status: 200, version: await store.version() };
}
