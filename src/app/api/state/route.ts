// GET /api/state: { version, import: { id, runDate, createdAt, bookingExportDate, files } | null }.
// Open screens poll this (feature 6c); a new version means something changed (import, Booked, undo).
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore } from '@/lib/storage';
import { getState } from '@/lib/server/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request?: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  return Response.json(await getState(getStore()), { headers: { 'Cache-Control': 'no-store' } });
}
