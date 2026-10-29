// Read-only answers for the routes and pages. Thin: everything comes from getCurrent (the one pipeline).
// Server only.
import { lineVerdictsCsv } from '@/lib/run';
import type { Store } from '@/lib/storage/types';
import { claudeConfigured } from '@/lib/server/claude-client';
import { getCurrent } from '@/lib/server/current';
import { adminView, importInfo } from '@/lib/server/views';
import type { AdminView, ImportInfo } from '@/lib/server/views';

export type AdminResponse = AdminView | { empty: true };

/** B5 for the latest import, or { empty: true } before the first one. */
export async function getAdminView(store: Store): Promise<AdminResponse> {
  const current = await getCurrent(store);
  if (!current) return { empty: true };
  return adminView(current.run, current.imp, { claudeConnected: claudeConfigured() });
}

export interface StateResponse {
  version: number;
  import: ImportInfo | null;
}

/** What open screens poll (feature 6c): a change of `version` means "fetch again". */
export async function getState(store: Store): Promise<StateResponse> {
  const version = await store.version();
  const imp = await store.latestImport();
  return { version, import: imp ? importInfo(imp) : null };
}

/** line_verdicts.csv for the current run, or null before the first import. */
export async function getLineVerdictsCsv(store: Store): Promise<{ runDate: string; csv: string } | null> {
  const current = await getCurrent(store);
  if (!current) return null;
  const { run } = current;
  return { runDate: run.runDate, csv: lineVerdictsCsv(run.lines, run.verdicts, run.reasons) };
}
