// The one place the tool's state lives (build-plan section 4, "Keeping the backend in sync (Booked)").
// Every screen and route reads through a Store; nothing keeps its own copy. LocalStore (JSON files) is the
// default; a Supabase adapter (feature 6e) implements the same interface.
import type { ReadingCache } from '@/lib/readings/cache';
import type { RunSummary } from '@/lib/run';
import type { BookedRecord } from '@/lib/types';

export type InputKind = 'waitlist' | 'openings' | 'appointments';

/** One CSV file exactly as it was imported. The text is kept so every screen can re-run the same pipeline. */
export interface StoredFile {
  name: string;
  /** sha256 of the file's text (UTF-8, BOM removed). */
  sha256: string;
  text: string;
}

export interface ImportSummary {
  /** The run's summary at import time (counts, not-read people). */
  run: RunSummary;
  /** Date part (YYYY-MM-DD) of the latest `booked_at` in the booking export; null when the file has none. */
  bookingExportDate: string | null;
  /** Data rows per file. */
  rows: Record<InputKind, number>;
}

/** One "Import and analyse" (B5). Every import is kept; the latest one is what the screens use. */
export interface StoredImport {
  id: string;
  /** ISO date the waitlist is read for. */
  runDate: string;
  /** ISO timestamp. */
  createdAt: string;
  files: Record<InputKind, StoredFile>;
  summary: ImportSummary;
}

export type AddBookedResult = { ok: true } | { ok: false; existing: BookedRecord };

export interface Store {
  /** The newest import, or null before the first one. */
  latestImport(): Promise<StoredImport | null>;
  /** Saves a new import and makes it the latest. Earlier imports are kept. */
  saveImport(i: StoredImport): Promise<void>;
  /** The Claude readings cache (seeded from the saved sample readings in local mode). */
  readingCache(): ReadingCache;
  /** Every Booked record, oldest first. */
  listBooked(): Promise<BookedRecord[]>;
  /** One booking per opening: a second record for the same opening is refused and nothing is saved. */
  addBooked(r: BookedRecord): Promise<AddBookedResult>;
  /** Undo. Returns false when the opening had no booking. */
  removeBooked(openingId: string): Promise<boolean>;
  /** Goes up by one on every change (import, booked, undo). Screens poll it to know when to refresh. */
  version(): Promise<number>;
}
