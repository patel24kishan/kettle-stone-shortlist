// The dev-only login-off switch (SHORTLIST_LOGIN_OFF=1 under npm run dev): Supabase still stores everything, but
// the proxy and the route check act as if a staff member were signed in. Ignored outside development.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_OFF_STAFF, loginOff } from '@/lib/supabase/env';
import { STAFF_HEADER, staffLoginFrom } from '@/lib/supabase/staff';

const created = vi.hoisted(() => ({ n: 0 }));
vi.mock('@supabase/ssr', () => ({
  parseCookieHeader: () => [],
  createServerClient: () => {
    created.n++;
    return { auth: { getClaims: async () => ({ data: null, error: null }) } };
  },
}));

const { proxy } = await import('@/proxy');
const { requireStaff } = await import('@/lib/supabase/require-staff');

const NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SHORTLIST_DATA_DIR', 'SHORTLIST_LOGIN_OFF'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-not-real';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-not-real';
  created.n = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

const req = (path: string) => new NextRequest(new URL(path, 'http://localhost:3000'));

describe('login off (dev only)', () => {
  it('is on only with SHORTLIST_LOGIN_OFF=1 under development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(loginOff()).toBe(false);
    process.env.SHORTLIST_LOGIN_OFF = '1';
    expect(loginOff()).toBe(true);
    vi.stubEnv('NODE_ENV', 'production');
    expect(loginOff()).toBe(false);
    vi.stubEnv('NODE_ENV', 'test');
    expect(loginOff()).toBe(false);
  });

  it('dev + switch on: pages and APIs pass, the staff header says login off, /login goes to /search', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    process.env.SHORTLIST_LOGIN_OFF = '1';
    const page = await proxy(req('/search'));
    expect(page.status).toBe(200);
    expect(page.headers.get('location')).toBeNull();
    const fwd = page.headers.get(`x-middleware-request-${STAFF_HEADER}`);
    expect(fwd && staffLoginFrom(new Headers({ [STAFF_HEADER]: fwd }))).toBe(LOGIN_OFF_STAFF);
    expect((await proxy(req('/api/state'))).status).toBe(200);
    const login = await proxy(req('/login'));
    expect(login.headers.get('location')).toBe('http://localhost:3000/search');
    expect(await requireStaff(new Request('http://localhost:3000/api/state'))).toBeNull();
    expect(created.n).toBe(0); // never asked Supabase Auth
  });

  it('production with the switch on still requires the login', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.SHORTLIST_LOGIN_OFF = '1';
    expect((await proxy(req('/search'))).headers.get('location')).toContain('/login');
    expect((await proxy(req('/api/state'))).status).toBe(401);
    expect((await requireStaff(new Request('http://localhost:3000/api/state')))?.status).toBe(401);
  });

  it('dev without the switch still requires the login', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await proxy(req('/api/state'))).status).toBe(401);
  });
});
