// Which Supabase settings are present (feature 6e). Nothing here talks to Supabase or reads the keys' values
// beyond checking they are there; the keys are never logged or sent anywhere but Supabase.
//
// Supabase mode is on when NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both set and
// SHORTLIST_DATA_DIR is not (tests point SHORTLIST_DATA_DIR at a temp folder, and it always wins).
// The staff login and Realtime also need NEXT_PUBLIC_SUPABASE_ANON_KEY. Without Supabase mode the app runs on
// the local file store with no login (BUILD_PROGRESS A1, A3).

const value = (v: string | undefined): string => (v ?? '').trim();

export interface SupabaseServerEnv {
  url: string;
  serviceRoleKey: string;
}

export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

/** The server's Supabase settings, or null when either is missing. Ignores SHORTLIST_DATA_DIR. */
export function supabaseServerEnv(): SupabaseServerEnv | null {
  const url = value(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serviceRoleKey = value(process.env.SUPABASE_SERVICE_ROLE_KEY);
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

/** The URL and anon key the login and Realtime use, or null when either is missing. */
export function supabasePublicEnv(): SupabasePublicEnv | null {
  const url = value(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = value(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return url && anonKey ? { url, anonKey } : null;
}

/** True when SHORTLIST_DATA_DIR is set: the local store is used whatever else is set. */
export function localDirForced(): boolean {
  return value(process.env.SHORTLIST_DATA_DIR) !== '';
}

/** True when the app stores everything in Supabase and requires the staff login. */
export function supabaseMode(): boolean {
  return !localDirForced() && supabaseServerEnv() !== null;
}
