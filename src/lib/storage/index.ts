// Which store the app uses.
//   * Local mode (BUILD_PROGRESS A1): JSON files under <cwd>/.data/app/, or under SHORTLIST_DATA_DIR when that is
//     set (tests point it at a temp folder, and it always wins).
//   * Supabase mode (feature 6e): when NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set (and
//     SHORTLIST_DATA_DIR is not), getStore() returns the Supabase store instead. See supabase/schema.sql.
import path from 'node:path';
import { LocalStore } from '@/lib/storage/local';
import { SupabaseStore } from '@/lib/storage/supabase';
import type { Store } from '@/lib/storage/types';
import { supabaseMode, supabaseServerEnv } from '@/lib/supabase/env';
import { createServiceClient } from '@/lib/supabase/server';

export type { AddBookedResult, ImportSummary, InputKind, Store, StoredFile, StoredImport } from '@/lib/storage/types';
export { LocalStore } from '@/lib/storage/local';
export { SupabaseStore } from '@/lib/storage/supabase';

/** The local store's folder: SHORTLIST_DATA_DIR, else <cwd>/.data/app. */
export function localDataDir(): string {
  const fromEnv = (process.env.SHORTLIST_DATA_DIR ?? '').trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), '.data', 'app');
}

export type StoreKind = 'local' | 'supabase';

/** 'supabase' when both Supabase server settings are set and SHORTLIST_DATA_DIR is not; otherwise 'local'. */
export function storeKind(): StoreKind {
  return supabaseMode() ? 'supabase' : 'local';
}

// Kept on globalThis so dev-server reloads and separately bundled routes share one store per folder / project.
const g = globalThis as typeof globalThis & { __shortlistStores?: Map<string, Store> };

/** The store every route and screen uses. One instance per data folder (or Supabase project) per process. */
export function getStore(): Store {
  g.__shortlistStores ??= new Map();
  const env = storeKind() === 'supabase' ? supabaseServerEnv() : null;
  const key = env ? `supabase:${env.url}` : localDataDir();
  let store = g.__shortlistStores.get(key);
  if (!store) {
    store = env ? new SupabaseStore(createServiceClient(env)) : new LocalStore(key);
    g.__shortlistStores.set(key, store);
  }
  return store;
}
