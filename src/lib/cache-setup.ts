// The reading cache a run uses (build-plan section 4: same files always give the same readings).
// A run cache starts as a copy of the saved sample readings, so the sample runs offline with no Claude key,
// then grows as Claude reads new people. data/sample/ is only ever read, never written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileReadingCache } from '@/lib/readings/cache';

const PROJECT_ROOT = path.resolve(/*turbopackIgnore: true*/ path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SAMPLE_DIR = path.join(PROJECT_ROOT, 'data', 'sample');
export const DEFAULT_SEED = path.join(SAMPLE_DIR, 'readings.json');

export interface OpenRunCacheOptions {
  /** Saved readings copied into a new cache file. Default: data/sample/readings.json. */
  seedFrom?: string;
}

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * A FileReadingCache at `cachePath`. If the file does not exist it is created first, holding every entry
 * of `seedFrom` (an absent seed file gives an empty cache). Refuses a path inside data/sample/.
 */
export function openRunCache(cachePath: string, opts: OpenRunCacheOptions = {}): FileReadingCache {
  const target = path.resolve(/*turbopackIgnore: true*/ cachePath);
  if (isInside(target, SAMPLE_DIR)) {
    throw new Error(`The readings cache cannot be inside ${SAMPLE_DIR}: the saved sample readings are never written to.`);
  }
  if (!fs.existsSync(target)) {
    const seed = path.resolve(/*turbopackIgnore: true*/ opts.seedFrom ?? DEFAULT_SEED);
    let entries: Record<string, unknown> = {};
    if (fs.existsSync(seed)) {
      const text = fs.readFileSync(seed, 'utf8').replace(/^﻿/, '');
      const data: unknown = JSON.parse(text.trim() === '' ? '{}' : text);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error(`The saved readings file ${seed} is not a JSON object.`);
      }
      entries = data as Record<string, unknown>;
    }
    // Same layout as FileReadingCache writes: keys sorted, two-space indent, trailing newline.
    const sorted = Object.fromEntries(Object.keys(entries).sort().map((k) => [k, entries[k]]));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  }
  return new FileReadingCache(target);
}
