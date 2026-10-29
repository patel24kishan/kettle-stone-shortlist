// Staff login gate (feature 6e; build-plan section 4: "Supabase Auth for the staff login, which is needed because
// the app is on the internet"). Next 16 runs this before every matched request (Next 16 renamed middleware to proxy).
//
//   * Local mode (no Supabase settings, or SHORTLIST_DATA_DIR set): does nothing. No login (BUILD_PROGRESS A3).
//   * Supabase mode: refreshes the session cookie (@supabase/ssr), then
//       - signed in      -> the request goes on, with the staff login in STAFF_HEADER for the routes;
//       - not signed in  -> a page goes to /login?next=<page>; an /api/* call gets 401 JSON;
//       - /login and static files always go through.
//     If the anon key is missing nobody can sign in, so it stays closed (503 for /api, /login for pages) rather than
//     opening the clinic's data to the internet.
import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { LOGIN_OFF_STAFF, loginOff, supabaseMode, supabasePublicEnv } from '@/lib/supabase/env';
import { LOGIN_PATH, isApiPath as isApi, isLoginPath as isLogin, isStaticAsset, safeNext } from '@/lib/supabase/paths';
import { STAFF_HEADER } from '@/lib/supabase/staff';

function loginRedirect(request: NextRequest): NextResponse {
  const url = new URL(LOGIN_PATH, request.url);
  const back = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (back !== '/') url.searchParams.set('next', back);
  return NextResponse.redirect(url);
}

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (!supabaseMode()) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (isStaticAsset(pathname)) return NextResponse.next();

  // Dev-only switch (SHORTLIST_LOGIN_OFF=1 under npm run dev): act as if a staff member were signed in.
  if (loginOff()) {
    if (isLogin(pathname)) return NextResponse.redirect(new URL('/search', request.url));
    const headers = new Headers(request.headers);
    headers.set(STAFF_HEADER, encodeURIComponent(LOGIN_OFF_STAFF));
    return NextResponse.next({ request: { headers } });
  }

  const env = supabasePublicEnv();
  if (!env) {
    if (isApi(pathname)) {
      return NextResponse.json(
        { ok: false, message: 'Staff login is not set up yet (NEXT_PUBLIC_SUPABASE_ANON_KEY is missing).' },
        { status: 503, headers: NO_STORE },
      );
    }
    return isLogin(pathname) ? NextResponse.next() : loginRedirect(request);
  }

  // Cookies the auth client wants to write (a refreshed session, or a cleared one), applied to whatever we answer.
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const cacheHeaders: Record<string, string> = {};
  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookies, headers) {
        // Also onto the request, so the page rendering now sees the refreshed session.
        for (const { name, value } of cookies) request.cookies.set(name, value);
        pending.push(...cookies);
        Object.assign(cacheHeaders, headers);
      },
    },
  });

  let login: string | null = null;
  try {
    // getClaims verifies the session token (and refreshes it when it is about to expire).
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (claims) login = String(claims.email ?? claims.sub ?? 'staff');
  } catch {
    login = null; // Supabase unreachable or a broken cookie: treat as signed out.
  }

  let response: NextResponse;
  if (!login && isLogin(pathname)) {
    response = NextResponse.next();
  } else if (!login) {
    response = isApi(pathname)
      ? NextResponse.json({ ok: false, signedOut: true, message: 'Please sign in again.' }, { status: 401, headers: NO_STORE })
      : loginRedirect(request);
  } else if (isLogin(pathname)) {
    response = NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get('next')), request.url));
  } else {
    const headers = new Headers(request.headers);
    headers.set(STAFF_HEADER, encodeURIComponent(login));
    response = NextResponse.next({ request: { headers } });
  }

  for (const { name, value, options } of pending) response.cookies.set(name, value, options);
  for (const [key, value] of Object.entries(cacheHeaders)) response.headers.set(key, value);
  return response;
}

// Everything except Next's build files; the function itself also lets static files and /login through.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
