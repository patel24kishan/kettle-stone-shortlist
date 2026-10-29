// The staff login gate (src/proxy.ts, feature 6e). The Supabase auth call is mocked: no live project.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STAFF_HEADER, staffLoginFrom } from '@/lib/supabase/staff';
import { safeNext } from '@/lib/supabase/paths';

const auth = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  throws: false,
  /** Cookies the mocked client "refreshes" during getClaims. */
  refresh: [] as { name: string; value: string; options: Record<string, unknown> }[],
  created: 0,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: { cookies: { getAll(): unknown; setAll(c: unknown[], h: Record<string, string>): void } },
  ) => {
    auth.created++;
    return {
      auth: {
        getClaims: async () => {
          if (auth.throws) throw new Error('network down');
          if (auth.refresh.length > 0) opts.cookies.setAll(auth.refresh, { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0' });
          return auth.claims ? { data: { claims: auth.claims, header: {}, signature: new Uint8Array() }, error: null } : { data: null, error: null };
        },
      },
    };
  },
}));

const { proxy, config } = await import('@/proxy');

const NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SHORTLIST_DATA_DIR'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  auth.claims = null;
  auth.throws = false;
  auth.refresh = [];
  auth.created = 0;
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

function supabaseOn(anon = true) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-not-real';
  if (anon) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-not-real';
}

const req = (path: string, init?: { headers?: Record<string, string> }) => new NextRequest(`http://localhost:3000${path}`, init);
/** NextResponse.next() marks "carry on" with this header. */
const passedThrough = (res: Response) => res.headers.get('x-middleware-next') === '1';
/** Request headers the proxy handed on to the route. */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

describe('proxy in local mode (no Supabase settings)', () => {
  it.each(['/', '/search', '/today', '/admin', '/api/state', '/api/booked', '/login', '/_next/static/chunk.js'])(
    'passes %s through without asking Supabase',
    async (path) => {
      const res = await proxy(req(path));
      expect(passedThrough(res)).toBe(true);
      expect(res.status).toBe(200);
      expect(auth.created).toBe(0);
    },
  );

  it('stays off when only the anon key is set, or SHORTLIST_DATA_DIR forces the local store', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example-project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-not-real';
    expect(passedThrough(await proxy(req('/search')))).toBe(true);
    supabaseOn();
    process.env.SHORTLIST_DATA_DIR = '/tmp/some-test-dir';
    expect(passedThrough(await proxy(req('/api/state')))).toBe(true);
    expect(auth.created).toBe(0);
  });
});

describe('proxy in Supabase mode', () => {
  beforeEach(() => supabaseOn());

  it('sends a signed-out page request to /login, remembering the page', async () => {
    const res = await proxy(req('/today?date=2026-10-14'));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const to = new URL(res.headers.get('location')!);
    expect(to.pathname).toBe('/login');
    expect(to.searchParams.get('next')).toBe('/today?date=2026-10-14');
  });

  it('sends the home page to /login with no "next"', async () => {
    const to = new URL((await proxy(req('/'))).headers.get('location')!);
    expect(to.pathname).toBe('/login');
    expect(to.search).toBe('');
  });

  it('answers a signed-out /api/* call with 401 JSON', async () => {
    for (const path of ['/api/state', '/api/booked', '/api/line-verdicts.csv']) {
      const res = await proxy(req(path));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, signedOut: true, message: 'Please sign in again.' });
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
    }
  });

  it('treats a failing auth call as signed out', async () => {
    auth.throws = true;
    expect((await proxy(req('/api/state'))).status).toBe(401);
  });

  it('lets /login and static files through while signed out', async () => {
    for (const path of ['/login', '/login?next=%2Ftoday', '/_next/static/css/app.css', '/favicon.ico', '/logo.svg']) {
      const res = await proxy(req(path));
      expect(passedThrough(res)).toBe(true);
    }
  });

  it('lets a signed-in request through and passes on the staff login (a browser-sent copy is replaced)', async () => {
    auth.claims = { sub: 'user-1', email: 'tanya@kettleandstone.ca', role: 'authenticated' };
    const res = await proxy(req('/api/booked', { headers: { [STAFF_HEADER]: 'someone-else' } }));
    expect(passedThrough(res)).toBe(true);
    const value = forwarded(res, STAFF_HEADER);
    expect(value).not.toBeNull();
    expect(staffLoginFrom(new Headers({ [STAFF_HEADER]: value! }))).toBe('tanya@kettleandstone.ca');
    expect(passedThrough(await proxy(req('/search')))).toBe(true);
  });

  it('writes refreshed session cookies onto the response, with no-cache headers', async () => {
    auth.claims = { sub: 'user-1', email: 'tanya@kettleandstone.ca' };
    auth.refresh = [{ name: 'sb-example-auth-token', value: 'refreshed', options: { path: '/', sameSite: 'lax' } }];
    const res = await proxy(req('/today'));
    expect(passedThrough(res)).toBe(true);
    expect(res.headers.get('set-cookie')).toMatch(/sb-example-auth-token=refreshed/);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('sends a signed-in visit to /login on to the page it asked for (same site only)', async () => {
    auth.claims = { sub: 'user-1' };
    expect(new URL((await proxy(req('/login?next=%2Fadmin'))).headers.get('location')!).pathname).toBe('/admin');
    expect(new URL((await proxy(req('/login?next=https%3A%2F%2Fevil.example'))).headers.get('location')!).href).toBe('http://localhost:3000/');
  });

  it('stays closed when the anon key is missing (nobody could sign in)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const api = await proxy(req('/api/state'));
    expect(api.status).toBe(503);
    expect(new URL((await proxy(req('/search'))).headers.get('location')!).pathname).toBe('/login');
    expect(passedThrough(await proxy(req('/login')))).toBe(true);
  });
});

describe('proxy config and helpers', () => {
  it('matches everything but Next build files', () => {
    expect(config.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)']);
  });

  it('safeNext keeps same-site paths only', () => {
    expect(safeNext('/today?date=2026-10-14')).toBe('/today?date=2026-10-14');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil', '/login', 'today']) expect(safeNext(bad)).toBe('/');
  });
});
