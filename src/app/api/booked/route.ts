// Booked (build-plan section 4: save first, then show; one booking per opening; undo).
// POST /api/booked  JSON { openingId, lineId } -> 200 { ok, record, version }; 409 { ok: false, message, existing }
//   when the opening is already filled; 404 when the line is not someone the search can suggest now; 400 on bad input;
//   409 { ok: false, noImport: true } before the first import.
// DELETE /api/booked?openingId=O34 -> 200 { ok, version }; 404 when that opening has no booking.
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore, storeKind } from '@/lib/storage';
import { bookOpening, undoBooked } from '@/lib/server/search-service';
import { staffLoginFrom } from '@/lib/supabase/staff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function reply(result: { status: number } & Record<string, unknown>): Response {
  const { status, ...rest } = result;
  return Response.json(rest, { status, headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ ok: false, status: 400, message: 'Send { openingId, lineId } as JSON.' });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reply({ ok: false, status: 400, message: 'Send { openingId, lineId } as JSON.' });
  }
  const { openingId, lineId } = body as { openingId?: unknown; lineId?: unknown };
  const result = await bookOpening(getStore(), {
    openingId: typeof openingId === 'string' ? openingId : '',
    lineId: typeof lineId === 'string' ? lineId : '',
    // Supabase mode: the staff login the proxy checked. Local mode has no login, so the record says "local".
    by: storeKind() === 'supabase' ? staffLoginFrom(request.headers) : undefined,
  });
  return reply(result);
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  const openingId = new URL(request.url).searchParams.get('openingId');
  return reply(await undoBooked(getStore(), openingId));
}
