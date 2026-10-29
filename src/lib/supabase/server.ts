// The server's Supabase client (feature 6e): service-role key, no session, nothing cached by Next.
// Server only. The service-role key bypasses row level security, so it must never be sent to a browser:
// it is read from SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_ prefix, so Next never puts it in client code).
import { createClient } from '@supabase/supabase-js';
import type { SupabaseLike } from '@/lib/storage/supabase';
import type { SupabaseServerEnv } from '@/lib/supabase/env';

export function createServiceClient(env: SupabaseServerEnv): SupabaseLike {
  const client = createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // Every read must see the latest saved state (save first, then show), so no fetch is ever cached.
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
  });
  // supabase-js's builder types are far richer (generic per table) than SupabaseLike's few calls, so TypeScript
  // cannot compare them directly. The calls SupabaseLike names (from/select/eq/order/range/limit/maybeSingle/
  // insert/upsert/rpc) are the installed postgrest-js API.
  return client as unknown as SupabaseLike;
}
