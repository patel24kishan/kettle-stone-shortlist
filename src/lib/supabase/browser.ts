// The browser's Supabase client (feature 6e): anon key + the staff member's session cookie, for the login form,
// the sign-out control and Realtime. Client code only. The anon key is public by design; row level security
// (supabase/schema.sql) lets it read nothing but the version row, and only when signed in.
// Next puts NEXT_PUBLIC_ values into the browser code at build time, so they are read with literal names here.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
}

/** The URL and anon key built into the page, or null in local mode. */
export function publicSupabaseConfig(): PublicSupabaseConfig | null {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
  return url && anonKey ? { url, anonKey } : null;
}

/**
 * The page's one browser client (createBrowserClient keeps a single instance per page), or null in local mode.
 * @supabase/ssr is loaded only when Supabase is configured, so local mode never downloads it.
 */
export async function browserSupabase(): Promise<SupabaseClient | null> {
  const config = publicSupabaseConfig();
  if (!config) return null;
  const { createBrowserClient } = await import('@supabase/ssr');
  return createBrowserClient(config.url, config.anonKey);
}
