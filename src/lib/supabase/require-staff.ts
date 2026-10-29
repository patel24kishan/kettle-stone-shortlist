// The staff check each API route runs itself (feature 7; the Next docs advise checking auth in the route as well
// as in the proxy, so a route never depends on the proxy's matcher alone).
//
//   * Local mode (no Supabase settings, or SHORTLIST_DATA_DIR set): does nothing. No login (BUILD_PROGRESS A3).
//   * Supabase mode: verifies the staff session from the request's cookies with @supabase/ssr, the same way
//     src/proxy.ts does (getClaims verifies the session token). Signed out -> 401 JSON with the proxy's body, so
//     the screens react the same way; anon key missing -> 503 (nobody can sign in, so the route stays closed).
//
// It never writes cookies: the proxy runs first and has already refreshed the session (and put the refreshed
// cookies on the request the route sees), so a route only has to read them.
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import { supabaseMode, supabasePublicEnv } from '@/lib/supabase/env';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export const SIGNED_OUT_BODY = { ok: false, signedOut: true, message: 'Please sign in again.' } as const;
export const LOGIN_NOT_SET_UP_MESSAGE = 'Staff login is not set up yet (NEXT_PUBLIC_SUPABASE_ANON_KEY is missing).';

/**
 * null when the request may go on (local mode, or a signed-in staff member); otherwise the Response to send back.
 * Call it first in every handler: `const denied = await requireStaff(request); if (denied) return denied;`
 */
export async function requireStaff(request?: Request): Promise<Response | null> {
  if (!supabaseMode()) return null;

  const env = supabasePublicEnv();
  if (!env) return Response.json({ ok: false, message: LOGIN_NOT_SET_UP_MESSAGE }, { status: 503, headers: NO_STORE });

  const cookies = parseCookieHeader(request?.headers.get('cookie') ?? '').map(({ name, value }) => ({
    name,
    value: value ?? '',
  }));
  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookies;
      },
      setAll() {
        // Nothing to do: the proxy already refreshed the session for this request (see the top of this file).
      },
    },
  });

  try {
    const { data } = await supabase.auth.getClaims();
    if (data?.claims) return null;
  } catch {
    // Supabase unreachable or a broken cookie: treat as signed out, like the proxy.
  }
  return Response.json(SIGNED_OUT_BODY, { status: 401, headers: NO_STORE });
}
