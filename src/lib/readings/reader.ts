// Reads every person's lines once per import (build-plan section 6 Step 2). Cache hit: no call.
// Miss with a client: Claude reads, code validates, the result is cached. Miss without a client: the person
// is 'not read' (reading null); a later feature treats them as not offerable and B5 flags them.
import type Anthropic from '@anthropic-ai/sdk';
import type { Reading, WaitlistLine } from '@/lib/types';
import type { BuildPeopleOptions } from '@/lib/import';
import type { ReadingCache } from '@/lib/readings/cache';
import { readingKey } from '@/lib/readings/hash';
import { readWithClaude } from '@/lib/readings/claude';
import type { ReadingCallLog } from '@/lib/readings/claude';
import { validateReading } from '@/lib/readings/validate';

export type ReadStatus = 'cached' | 'claude' | 'not read' | 'failed';

export interface ReadResult {
  reading: Reading | null;
  status: ReadStatus;
  problems: string[];
  key: string;
}

export interface ReadAllOptions {
  cache: ReadingCache;
  client: Anthropic | null;
  runYear: number;
  /** How many Claude calls run at once (build-plan section 4: parallel batches). Default 6. */
  concurrency?: number;
  log?: (entry: ReadingCallLog) => void;
  /** Clock for `readAt` (tests). */
  now?: () => Date;
}

const newestId = (group: WaitlistLine[]): string => group[group.length - 1]!.id;

/** Runs `work` for each item with at most `limit` running at once. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}

/** Reads every group. The map is keyed by each group's newest line id, in the groups' order. */
export async function readAll(groups: WaitlistLine[][], opts: ReadAllOptions): Promise<Map<string, ReadResult>> {
  const results = new Map<string, ReadResult>();
  const misses: { group: WaitlistLine[]; key: string }[] = [];
  const now = opts.now ?? (() => new Date());

  for (const group of groups) {
    const key = readingKey(group, opts.runYear);
    const hit = await opts.cache.get(key);
    if (hit) {
      results.set(newestId(group), { reading: hit.reading, status: 'cached', problems: hit.problems, key });
    } else {
      // Placeholder keeps the map in group order; filled in below.
      results.set(newestId(group), { reading: null, status: 'not read', problems: [], key });
      misses.push({ group, key });
    }
  }

  const client = opts.client;
  if (!client) {
    for (const { group, key } of misses) {
      results.set(newestId(group), {
        reading: null,
        status: 'not read',
        problems: ['Not read yet: no saved reading for these lines and no Claude key set.'],
        key,
      });
    }
    return results;
  }

  await pool(misses, opts.concurrency ?? 6, async ({ group, key }) => {
    const res = await readWithClaude(group, { client, runYear: opts.runYear, log: opts.log });
    if (!res.ok) {
      results.set(newestId(group), { reading: null, status: 'failed', problems: [res.problem], key });
      return;
    }
    const { reading, problems } = validateReading(res.raw, group);
    await opts.cache.set(key, { reading, readAt: now().toISOString(), by: 'claude', problems });
    results.set(newestId(group), { reading, status: 'claude', problems, key });
  });

  return results;
}

/**
 * The `getReading(group)` Feature 1's buildPeople expects. Returns the reading for a group whose lines are
 * exactly one of `groups`; undefined for a group that was not read (or is unknown).
 */
export function makeGetReading(
  results: Map<string, ReadResult>,
  groups: WaitlistLine[][],
): BuildPeopleOptions['getReading'] {
  const linesOf = new Map(groups.map((g) => [newestId(g), g.map((l) => l.id).join(',')]));
  return (group) => {
    if (group.length === 0) return undefined;
    const id = newestId(group);
    if (linesOf.get(id) !== group.map((l) => l.id).join(',')) return undefined;
    return results.get(id)?.reading ?? undefined;
  };
}
