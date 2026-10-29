// Where readings are kept between imports (build-plan section 4 and 6 Step 2). Memory for tests, a JSON
// file for local runs and the saved sample readings. A Supabase adapter (feature 6a) implements the same
// interface. Entries never contain names or phones.
import fs from 'node:fs';
import path from 'node:path';
import type { Reading } from '@/lib/types';

export interface ReadingCacheEntry {
  reading: Reading;
  readAt: string; // ISO timestamp
  by: 'claude' | 'saved';
  problems: string[]; // validation problems, shown in B5
}

export interface ReadingCache {
  get(key: string): Promise<ReadingCacheEntry | undefined>;
  set(key: string, entry: ReadingCacheEntry): Promise<void>;
  /** Every entry, keys sorted. */
  all(): Promise<Record<string, ReadingCacheEntry>>;
}

function sortedRecord(map: Map<string, ReadingCacheEntry>): Record<string, ReadingCacheEntry> {
  const out: Record<string, ReadingCacheEntry> = {};
  for (const k of [...map.keys()].sort()) out[k] = map.get(k)!;
  return out;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryReadingCache implements ReadingCache {
  private readonly map = new Map<string, ReadingCacheEntry>();

  constructor(initial?: Record<string, ReadingCacheEntry>) {
    for (const [k, v] of Object.entries(initial ?? {})) this.map.set(k, clone(v));
  }

  async get(key: string) {
    const e = this.map.get(key);
    return e ? clone(e) : undefined;
  }

  async set(key: string, entry: ReadingCacheEntry) {
    this.map.set(key, clone(entry));
  }

  async all() {
    return clone(sortedRecord(this.map));
  }
}

/**
 * A JSON file: `{ "<key>": { reading, readAt, by, problems }, ... }`, keys sorted, two-space indent.
 * Loaded on first use. Every `set` rewrites the file atomically (temp file in the same folder, then rename).
 */
export class FileReadingCache implements ReadingCache {
  private map: Map<string, ReadingCacheEntry> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  private load(): Map<string, ReadingCacheEntry> {
    if (this.map) return this.map;
    this.map = new Map();
    if (fs.existsSync(this.filePath)) {
      const text = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(text.trim() === '' ? '{}' : text) as Record<string, ReadingCacheEntry>;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error(`The readings file ${this.filePath} is not a JSON object.`);
      }
      for (const [k, v] of Object.entries(data)) this.map.set(k, v);
    }
    return this.map;
  }

  async get(key: string) {
    const e = this.load().get(key);
    return e ? clone(e) : undefined;
  }

  async set(key: string, entry: ReadingCacheEntry) {
    this.load().set(key, clone(entry));
    // Serialise writes so parallel sets never interleave; each write holds the full current map.
    this.writing = this.writing.catch(() => undefined).then(() => this.flush());
    await this.writing;
  }

  async all() {
    return clone(sortedRecord(this.load()));
  }

  private async flush(): Promise<void> {
    const text = `${JSON.stringify(sortedRecord(this.load()), null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}
