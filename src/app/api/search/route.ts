// POST /api/search (A1, one opening): JSON { date, start, therapist, length, cancelledAt }.
// 200 { ok, opening, context }; 400 { ok: false, message } on invalid input; 409 before the first import.
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore } from '@/lib/storage';
import { searchOne } from '@/lib/server/search-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, message: 'Send the opening as JSON.' }, { status: 400, headers: NO_STORE });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Response.json({ ok: false, message: 'Send the opening as JSON.' }, { status: 400, headers: NO_STORE });
  }
  const result = await searchOne(getStore(), body as Record<string, unknown>);
  if (!result.ok) {
    const { status, ...rest } = result;
    return Response.json(rest, { status, headers: NO_STORE });
  }
  return Response.json(result, { headers: NO_STORE });
}
