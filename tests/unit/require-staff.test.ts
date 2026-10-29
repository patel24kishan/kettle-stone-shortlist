// The per-route staff check (src/lib/supabase/require-staff.ts, feature 7). The Supabase auth call is mocked: no live
// project. Local mode must do nothing; Supabase mode must verify the session from the request cookies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  claims: null as Record<string, unknown> | null,
  throws: false,
  created: 0,
  /** The cookies the auth client was given, per client. */
  seen: [] as { name: string; value: string }[][],
}));

vi.mock('@supabase/ssr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/ssr')>()),
  createServerClient: (_url: string, _key: string, opts: { cookies: { getAll(): { name: string; value: string }[] } }) => {
    auth.created++;
    return {
      auth: {
        getClaims: async () => {
          auth.seen.push(opts.cookies.getAll());
          if (auth.throws) throw new Error('network down');
          return auth.claims ? { data: { claims: auth.claims }, error: null } : { data: null, error: null };
        },
      },
    };
  },
}));

const { requireStaff, SIGNED_OUT_BODY } = await import('@/lib/supabase/require-staff');
const routes = {
  admin: await import('@/app/api/admin/route'),
  booked: await import('@/app/api/booked/route'),
  import: await import('@/app/api/import/route'),
  verdicts: await import('@/app/api/line-verdicts.csv/route'),
  search: await import('@/app/api/search/route'),
  file: await import('@/app/api/search/file/route'),
  state: await import('@/app/api/state/route'),
  today: await import('@/app/api/today/route'),
};

const NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SHORTLIST_DATA_DIR'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  auth.claims = null;
  auth.throws = false;
  auth.created = 0;
  auth.seen = [];
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

const req = (cookie?: string) =>
  new Request('http://localhost/api/state', cookie ? { headers: { cookie } } : undefined);

describe('local mode', () => {
  it('does nothing: no auth client, the request goes on', async () => {
    expect(await requireStaff(req())).toBeNull();
    expect(await requireStaff()).toBeNull();
    expect(auth.created).toBe(0);
  });

  it('SHORTLIST_DATA_DIR wins over Supabase settings (tests and local runs)', async () => {
    supabaseOn();
    process.env.SHORTLIST_DATA_DIR = '/tmp/somewhere';
    expect(await requireStaff(req())).toBeNull();
    expect(auth.created).toBe(0);
  });
});

describe('Supabase mode', () => {
  it('signed in: the request goes on', async () => {
    supabaseOn();
    auth.claims = { email: 'tanya@kettleandstone.ca', sub: 'u1' };
    expect(await requireStaff(req('sb-example-auth-token=abc'))).toBeNull();
  });

  it('reads the session from the request cookies', async () => {
    supabaseOn();
    auth.claims = { sub: 'u1' };
    await requireStaff(req('sb-example-auth-token=abc%3D%3D; other=1'));
    expect(auth.seen[0]).toEqual([
      { name: 'sb-example-auth-token', value: 'abc==' },
      { name: 'other', value: '1' },
    ]);
  });

  it('signed out: 401 with the same body the proxy sends', async () => {
    supabaseOn();
    const res = await requireStaff(req());
    expect(res?.status).toBe(401);
    expect(await res!.json()).toEqual(SIGNED_OUT_BODY);
    expect(res!.headers.get('cache-control')).toContain('no-store');
    expect(auth.seen[0]).toEqual([]);
  });

  it('Supabase unreachable or a broken cookie counts as signed out', async () => {
    supabaseOn();
    auth.throws = true;
    expect((await requireStaff(req('sb-x=broken')))?.status).toBe(401);
  });

  it('no anon key: nobody can sign in, so the route stays closed (503)', async () => {
    supabaseOn(false);
    const res = await requireStaff(req());
    expect(res?.status).toBe(503);
    expect(auth.created).toBe(0);
  });
});

describe('every API route checks the staff session first', () => {
  const handlers: [string, () => Promise<Response>][] = [
    ['GET /api/admin', () => routes.admin.GET(req())],
    ['POST /api/booked', () => routes.booked.POST(new Request('http://localhost/api/booked', { method: 'POST', body: '{}' }))],
    ['DELETE /api/booked', () => routes.booked.DELETE(new Request('http://localhost/api/booked?openingId=O34', { method: 'DELETE' }))],
    ['POST /api/import', () => routes.import.POST(new Request('http://localhost/api/import', { method: 'POST', body: new FormData() }))],
    ['GET /api/line-verdicts.csv', () => routes.verdicts.GET(req())],
    ['POST /api/search', () => routes.search.POST(new Request('http://localhost/api/search', { method: 'POST', body: '{}' }))],
    ['POST /api/search/file', () => routes.file.POST(new Request('http://localhost/api/search/file', { method: 'POST', body: new FormData() }))],
    ['GET /api/state', () => routes.state.GET(req())],
    ['GET /api/today', () => routes.today.GET(new Request('http://localhost/api/today?date=2026-10-14'))],
  ];

  it.each(handlers)('%s answers 401 when signed out (before touching the store)', async (_name, call) => {
    supabaseOn();
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(SIGNED_OUT_BODY);
  });

  it('every handler under src/app/api starts with requireStaff', () => {
    const apiDir = fileURLToPath(new URL('../../src/app/api/', import.meta.url));
    const files = fs
      .readdirSync(apiDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name === 'route.ts')
      .map((e) => path.join(e.parentPath, e.name));
    expect(files.length).toBe(8);
    let handlerCount = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const heads = [...text.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)[^{]*\{\n([^\n]*)\n([^\n]*)/g)];
      expect(heads.length, file).toBeGreaterThan(0);
      for (const m of heads) {
        handlerCount++;
        expect(m[2]!.trim(), `${file} ${m[1]}`).toBe('const denied = await requireStaff(request);');
        expect(m[3]!.trim(), `${file} ${m[1]}`).toBe('if (denied) return denied;');
      }
    }
    expect(handlerCount).toBe(handlers.length);
  });
});
