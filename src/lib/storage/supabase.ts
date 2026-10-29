// Supabase store (feature 6e, build-plan section 4 "Keeping the backend in sync"). Same Store interface as the
// local file store; the tables and rules are in supabase/schema.sql. Server only: it uses the service-role key,
// which must never reach a browser.
//
// The database does the hard parts, so two devices tapping at the same moment get the same answer:
//   * one booking per opening and one live booking per person are unique constraints, so addBooked just inserts
//     and turns a "duplicate" error into { ok: false, existing };
//   * undo is one SQL function (undo_booked) that copies the row to booked_history and deletes it together;
//   * the version goes up by a trigger inside the same transaction as each import, booking and undo.
//
// The store is written against SupabaseLike: only the few query-builder calls it uses. The real supabase-js client
// fits it, and so does the in-memory fake the contract tests use (tests/unit/store-contract.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SEED } from '@/lib/cache-setup';
import type { ReadingCache, ReadingCacheEntry } from '@/lib/readings/cache';
import type { AddBookedResult, ImportSummary, InputKind, Store, StoredFile, StoredImport } from '@/lib/storage/types';
import type { BookedRecord } from '@/lib/types';

// ---- the slice of supabase-js the store uses ----------------------------------------------------------

export interface DbError {
  /** Postgres / PostgREST error code, e.g. "23505" for a unique violation. */
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export interface DbResponse<T> {
  data: T | null;
  error: DbError | null;
}

export type Row = Record<string, unknown>;

/** A select query: filters and ordering chain; awaiting it gives the rows. */
export interface SelectQuery extends PromiseLike<DbResponse<Row[]>> {
  eq(column: string, value: string | number): SelectQuery;
  order(column: string, options?: { ascending?: boolean }): SelectQuery;
  range(from: number, to: number): SelectQuery;
  limit(count: number): SelectQuery;
  maybeSingle(): PromiseLike<DbResponse<Row>>;
}

export interface TableLike {
  select(columns?: string): SelectQuery;
  insert(row: Row): PromiseLike<DbResponse<unknown>>;
  upsert(row: Row, options?: { onConflict?: string }): PromiseLike<DbResponse<unknown>>;
}

export interface SupabaseLike {
  from(table: string): TableLike;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<DbResponse<unknown>>;
}

export const UNIQUE_VIOLATION = '23505';
/** Rows per request when reading a whole table (PostgREST returns at most 1000 by default). */
const PAGE = 500;
const ID_RE = /^[A-Za-z0-9_-]+$/;

export class SupabaseStoreError extends Error {
  constructor(
    what: string,
    readonly cause: DbError,
  ) {
    // The message names the step and Postgres' own words; it never contains keys.
    super(`Supabase: could not ${what} (${cause.code ?? 'no code'}: ${cause.message}).`);
    this.name = 'SupabaseStoreError';
  }
}

function must<T>(res: DbResponse<T>, what: string): T | null {
  if (res.error) throw new SupabaseStoreError(what, res.error);
  return res.data;
}

/** Postgres returns "2026-10-21 14:00:00+00" style times; the app keeps ISO strings like "2026-10-21T14:00:00.000Z". */
function isoTime(v: unknown): string {
  const s = String(v ?? '');
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

/** Every row of a select, page by page, in the given order. */
async function selectAll(build: () => SelectQuery, what: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = must(await build().range(from, from + PAGE - 1), what) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

// ---- row <-> record ------------------------------------------------------------------------------------

function bookedRow(r: BookedRecord): Row {
  return {
    opening_id: r.openingId,
    person_phone_digits: r.personPhoneDigits,
    person_name: r.personName,
    line_id: r.lineId,
    at: r.at,
    by: r.by,
  };
}

function bookedRecord(row: Row): BookedRecord {
  return {
    personPhoneDigits: String(row.person_phone_digits),
    personName: String(row.person_name),
    lineId: String(row.line_id),
    openingId: String(row.opening_id),
    at: isoTime(row.at),
    by: String(row.by),
  };
}

function importRecord(row: Row): StoredImport {
  return {
    id: String(row.id),
    runDate: String(row.run_date).slice(0, 10),
    createdAt: isoTime(row.created_at),
    files: row.files as Record<InputKind, StoredFile>,
    summary: row.summary as ImportSummary,
  };
}

const BOOKED_COLUMNS = 'opening_id, person_phone_digits, person_name, line_id, at, by';

// ---- readings cache ------------------------------------------------------------------------------------

/** Saved sample readings (read-only): what the local store copies into a new cache, served here as a fallback. */
function loadSeed(file: string): Map<string, ReadingCacheEntry> {
  const map = new Map<string, ReadingCacheEntry>();
  if (!fs.existsSync(file)) return map;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const data: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`The saved readings file ${file} is not a JSON object.`);
  }
  for (const [k, v] of Object.entries(data)) map.set(k, v as ReadingCacheEntry);
  return map;
}

/**
 * The readings cache over the reading_cache table. Entries for a key never change in practice (the key is a hash
 * of the person's lines), so entries already seen are kept in memory: an import reads ~50 people one by one and
 * should not cost 50 round trips. A key not seen yet is always asked for, so another server's new readings are
 * found. The saved sample readings answer for keys the table does not have (like the local store's seeded copy).
 */
export class SupabaseReadingCache implements ReadingCache {
  private known = new Map<string, ReadingCacheEntry>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly db: SupabaseLike,
    private readonly seed: Map<string, ReadingCacheEntry>,
  ) {}

  private loadOnce(): Promise<void> {
    const loading = (this.loaded ??= this.refresh().then(
      () => undefined,
      (err: unknown) => {
        this.loaded = null;
        throw err;
      },
    ));
    return loading;
  }

  private async refresh(): Promise<Map<string, ReadingCacheEntry>> {
    const rows = await selectAll(() => this.db.from('reading_cache').select('key, entry').order('key'), 'read the readings');
    const fresh = new Map<string, ReadingCacheEntry>();
    for (const row of rows) fresh.set(String(row.key), row.entry as ReadingCacheEntry);
    for (const [k, v] of fresh) this.known.set(k, v);
    return fresh;
  }

  async get(key: string): Promise<ReadingCacheEntry | undefined> {
    await this.loadOnce();
    let entry = this.known.get(key);
    if (!entry) {
      const row = must(await this.db.from('reading_cache').select('key, entry').eq('key', key).maybeSingle(), 'read a reading');
      if (row) {
        entry = row.entry as ReadingCacheEntry;
        this.known.set(key, entry);
      }
    }
    entry ??= this.seed.get(key);
    return entry ? structuredClone(entry) : undefined;
  }

  async set(key: string, entry: ReadingCacheEntry): Promise<void> {
    const copy = structuredClone(entry);
    must(await this.db.from('reading_cache').upsert({ key, entry: copy }, { onConflict: 'key' }), 'save a reading');
    this.known.set(key, copy);
  }

  async all(): Promise<Record<string, ReadingCacheEntry>> {
    const fresh = await this.refresh();
    const merged = new Map(this.seed);
    for (const [k, v] of fresh) merged.set(k, v);
    const out: Record<string, ReadingCacheEntry> = {};
    for (const k of [...merged.keys()].sort()) out[k] = structuredClone(merged.get(k)!);
    return out;
  }
}

// ---- the store -----------------------------------------------------------------------------------------

export interface SupabaseStoreOptions {
  /** Saved readings used when the table has no entry for a key. Default: data/sample/readings.json. */
  seedReadingsFrom?: string;
}

export class SupabaseStore implements Store {
  private cache: SupabaseReadingCache | null = null;
  /** Imports never change once saved, so the latest one is kept in memory by id. */
  private latest: StoredImport | null = null;
  private readonly seedFile: string;

  constructor(
    private readonly db: SupabaseLike,
    opts: SupabaseStoreOptions = {},
  ) {
    this.seedFile = path.resolve(/*turbopackIgnore: true*/ opts.seedReadingsFrom ?? DEFAULT_SEED);
  }

  async latestImport(): Promise<StoredImport | null> {
    // A small query for the newest id first; the files (tens of KB) are fetched only when that id is new.
    const head = must(
      await this.db.from('imports').select('id').order('seq', { ascending: false }).limit(1).maybeSingle(),
      'find the latest import',
    );
    if (!head) return null;
    const id = String(head.id);
    if (this.latest?.id === id) return structuredClone(this.latest);
    const row = must(
      await this.db.from('imports').select('id, run_date, created_at, files, summary').eq('id', id).maybeSingle(),
      'read the latest import',
    );
    if (!row) return null;
    this.latest = importRecord(row);
    return structuredClone(this.latest);
  }

  async saveImport(i: StoredImport): Promise<void> {
    if (!ID_RE.test(i.id)) throw new Error(`Import id "${i.id}" may only use letters, digits, - and _.`);
    const res = await this.db.from('imports').insert({
      id: i.id,
      run_date: i.runDate,
      created_at: i.createdAt,
      files: i.files,
      summary: i.summary,
    });
    if (res.error?.code === UNIQUE_VIOLATION) {
      throw new Error(`An import with id ${i.id} is already saved; imports are never replaced.`);
    }
    must(res, 'save the import');
    this.latest = structuredClone(i);
  }

  /** Ids of every saved import, oldest first. */
  async listImportIds(): Promise<string[]> {
    const rows = await selectAll(() => this.db.from('imports').select('id').order('seq', { ascending: true }), 'list imports');
    return rows.map((r) => String(r.id));
  }

  readingCache(): ReadingCache {
    this.cache ??= new SupabaseReadingCache(this.db, loadSeed(this.seedFile));
    return this.cache;
  }

  async listBooked(): Promise<BookedRecord[]> {
    const rows = await selectAll(
      () => this.db.from('booked').select(BOOKED_COLUMNS).order('at', { ascending: true }).order('seq', { ascending: true }),
      'read the Booked list',
    );
    return rows.map(bookedRecord);
  }

  private async findBooked(column: 'opening_id' | 'person', r: BookedRecord): Promise<BookedRecord | null> {
    let q = this.db.from('booked').select(BOOKED_COLUMNS);
    q = column === 'opening_id' ? q.eq('opening_id', r.openingId) : q.eq('line_id', r.lineId).eq('person_phone_digits', r.personPhoneDigits);
    const row = must(await q.maybeSingle(), 'look up a booking');
    return row ? bookedRecord(row) : null;
  }

  async addBooked(r: BookedRecord): Promise<AddBookedResult> {
    // No check before the insert: the unique constraints decide, so a race between two devices has one winner.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.db.from('booked').insert(bookedRow(r));
      if (!res.error) return { ok: true };
      if (res.error.code !== UNIQUE_VIOLATION) throw new SupabaseStoreError('save the booking', res.error);
      const existing = (await this.findBooked('opening_id', r)) ?? (await this.findBooked('person', r));
      if (existing) return { ok: false, existing };
      // The booking that blocked this one was undone in between: try again.
    }
    throw new Error('Supabase: the booking kept clashing with another change. Try again.');
  }

  async removeBooked(openingId: string): Promise<boolean> {
    // undo_booked copies the row to booked_history and deletes it in one transaction (nothing is lost).
    const data = must(await this.db.rpc('undo_booked', { p_opening_id: openingId }), 'undo the booking');
    return data === true;
  }

  async version(): Promise<number> {
    const row = must(await this.db.from('app_state').select('version').eq('id', 1).maybeSingle(), 'read the version');
    const v = Number(row?.version ?? 0);
    return Number.isFinite(v) ? v : 0;
  }
}
