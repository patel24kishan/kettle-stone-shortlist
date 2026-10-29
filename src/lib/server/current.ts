// The current run: the latest import, run again with today's Booked records and no Claude client (only the
// import calls Claude; everything else uses the cached readings). Every screen and route uses this, through the
// same runShortlist the CLI uses, so screens and the CLI always agree (build-plan section 7).
// Server only.
import { runShortlist } from '@/lib/run';
import type { RunOutput } from '@/lib/run';
import type { Store, StoredImport } from '@/lib/storage/types';
import type { BookedRecord } from '@/lib/types';

export interface CurrentState {
  imp: StoredImport;
  run: RunOutput;
  booked: BookedRecord[];
  version: number;
}

// Memo per store, keyed by (import id, version): any import, booking or undo bumps the version.
const memo = new WeakMap<Store, { key: string; promise: Promise<CurrentState | null> }>();

async function compute(store: Store, version: number): Promise<CurrentState | null> {
  const imp = await store.latestImport();
  if (!imp) return null;
  const booked = await store.listBooked();
  const run = await runShortlist({
    waitlistText: imp.files.waitlist.text,
    openingsText: imp.files.openings.text,
    appointmentsText: imp.files.appointments.text,
    runDate: imp.runDate,
    cache: store.readingCache(),
    client: null,
    booked,
  });
  return { imp, run, booked, version };
}

/** The latest import's run with the store's Booked records, or null before the first import. */
export async function getCurrent(store: Store): Promise<CurrentState | null> {
  // Version first: data read after it is at least this new, so a memo entry is never older than its key.
  const version = await store.version();
  const imp = await store.latestImport();
  const key = `${imp?.id ?? 'none'}@${version}`;
  const hit = memo.get(store);
  if (hit && hit.key === key) return hit.promise;
  const promise = compute(store, version);
  memo.set(store, { key, promise });
  promise.catch(() => {
    if (memo.get(store)?.promise === promise) memo.delete(store);
  });
  return promise;
}

/** The RunOutput every screen uses, or null before the first import. */
export async function getCurrentRun(store: Store): Promise<RunOutput | null> {
  return (await getCurrent(store))?.run ?? null;
}
