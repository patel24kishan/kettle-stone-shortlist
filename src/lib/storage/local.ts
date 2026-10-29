// Local file store (BUILD_PROGRESS A1/A3: the default until Supabase is connected). Layout under `dir`:
//   imports/<id>.json      every import, never deleted
//   latest.json            { "id": "<newest import id>" }
//   booked.json            BookedRecord[] (one per opening)
//   booked-history.json    undone bookings, kept for the record (rules.md "Nothing is deleted")
//   readings-cache.json    Claude readings, seeded from data/sample/readings.json (via openRunCache)
//   version.json           { "version": n }, +1 on every change
// Every write goes to a temp file in the same folder and is renamed into place, and all changes to one folder
// run one at a time in this process, so a reader never sees half a file.
import fs from 'node:fs';
import path from 'node:path';
import { openRunCache } from '@/lib/cache-setup';
import type { ReadingCache } from '@/lib/readings/cache';
import type { AddBookedResult, Store, StoredImport } from '@/lib/storage/types';
import type { BookedRecord } from '@/lib/types';

export interface LocalStoreOptions {
  /** Saved readings copied into a new readings cache. Default: <cwd>/data/sample/readings.json. */
  seedReadingsFrom?: string;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** One queue per folder, shared by every LocalStore on it in this process. */
const queues = new Map<string, Promise<unknown>>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes `text` to `file` atomically: temp file in the same folder, then rename (retried briefly on Windows locks). */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // the temp file is harmless if it stays
      }
      throw err;
    }
  }
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim() === '') return fallback;
  return JSON.parse(text) as T;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export class LocalStore implements Store {
  readonly dir: string;
  private readonly seed: string;
  private cache: ReadingCache | null = null;
  /** Imports never change once saved, so the latest one can be kept in memory by id. */
  private latest: StoredImport | null = null;

  constructor(dir: string, opts: LocalStoreOptions = {}) {
    // The folders are chosen at run time, not bundled (turbopackIgnore keeps the build from tracing them).
    this.dir = path.resolve(/*turbopackIgnore: true*/ dir);
    this.seed = path.resolve(
      /*turbopackIgnore: true*/ opts.seedReadingsFrom ?? path.join(process.cwd(), 'data', 'sample', 'readings.json'),
    );
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private importFile(id: string): string {
    return path.join(this.dir, 'imports', `${id}.json`);
  }

  /** Runs `fn` after every earlier change to this folder has finished. */
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = queues.get(this.dir) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    queues.set(
      this.dir,
      run.catch(() => undefined),
    );
    return run;
  }

  private bumpVersion(): number {
    const next = this.readVersion() + 1;
    writeFileAtomic(this.file('version.json'), json({ version: next }));
    return next;
  }

  private readVersion(): number {
    const v = readJson<{ version?: unknown }>(this.file('version.json'), {}).version;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  private readBooked(): BookedRecord[] {
    const data = readJson<unknown>(this.file('booked.json'), []);
    if (!Array.isArray(data)) throw new Error(`${this.file('booked.json')} is not a list.`);
    return data as BookedRecord[];
  }

  async latestImport(): Promise<StoredImport | null> {
    const pointer = readJson<{ id?: unknown }>(this.file('latest.json'), {});
    if (typeof pointer.id !== 'string' || !ID_RE.test(pointer.id)) return null;
    if (this.latest?.id === pointer.id) return this.latest;
    const file = this.importFile(pointer.id);
    if (!fs.existsSync(file)) return null;
    this.latest = readJson<StoredImport>(file, null as unknown as StoredImport);
    return this.latest;
  }

  async saveImport(i: StoredImport): Promise<void> {
    if (!ID_RE.test(i.id)) throw new Error(`Import id "${i.id}" may only use letters, digits, - and _.`);
    await this.exclusive(() => {
      const file = this.importFile(i.id);
      if (fs.existsSync(file)) throw new Error(`An import with id ${i.id} is already saved; imports are never replaced.`);
      writeFileAtomic(file, json(i));
      writeFileAtomic(this.file('latest.json'), json({ id: i.id }));
      this.latest = structuredClone(i);
      this.bumpVersion();
    });
  }

  /** Ids of every saved import, oldest first (ids start with their creation time). */
  async listImportIds(): Promise<string[]> {
    const dir = path.join(this.dir, 'imports');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }

  readingCache(): ReadingCache {
    this.cache ??= openRunCache(this.file('readings-cache.json'), { seedFrom: this.seed });
    return this.cache;
  }

  async listBooked(): Promise<BookedRecord[]> {
    return [...this.readBooked()].sort((a, b) => a.at.localeCompare(b.at));
  }

  async addBooked(r: BookedRecord): Promise<AddBookedResult> {
    return this.exclusive((): AddBookedResult => {
      const booked = this.readBooked();
      // One booking per opening, and one live booking per person: the same person on the same newest line can't
      // fill two openings, even when two taps race (rules.md Step 2). A newer line (new lineId) may be booked again.
      const existing =
        booked.find((b) => b.openingId === r.openingId) ??
        booked.find((b) => b.lineId === r.lineId && b.personPhoneDigits === r.personPhoneDigits);
      if (existing) return { ok: false, existing };
      writeFileAtomic(this.file('booked.json'), json([...booked, r]));
      this.bumpVersion();
      return { ok: true };
    });
  }

  async removeBooked(openingId: string): Promise<boolean> {
    return this.exclusive(() => {
      const booked = this.readBooked();
      const gone = booked.filter((b) => b.openingId === openingId);
      if (gone.length === 0) return false;
      const history = readJson<unknown[]>(this.file('booked-history.json'), []);
      const undoneAt = new Date().toISOString();
      writeFileAtomic(this.file('booked-history.json'), json([...history, ...gone.map((record) => ({ record, undoneAt }))]));
      writeFileAtomic(this.file('booked.json'), json(booked.filter((b) => b.openingId !== openingId)));
      this.bumpVersion();
      return true;
    });
  }

  async version(): Promise<number> {
    return this.readVersion();
  }
}
