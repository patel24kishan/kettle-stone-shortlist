// Cache key for one person's reading (build-plan section 4: "cached by a hash of the person's lines, so the
// same files always give the same result"). Names and phones are not part of the key: they are never sent
// to Claude, so they cannot change the reading.
import { createHash } from 'node:crypto';
import type { WaitlistLine } from '@/lib/types';
import { SCHEMA_VERSION } from '@/lib/readings/schema';

/** sha256 over SCHEMA_VERSION, the run year and each line's id, date and notes, in the order given. */
export function readingKey(lines: WaitlistLine[], runYear: number): string {
  const payload = JSON.stringify([
    SCHEMA_VERSION,
    runYear,
    lines.map((l) => [l.id, l.date, l.notes]),
  ]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
