// GET /api/admin: what B5 shows for the latest import, or { empty: true }.
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore } from '@/lib/storage';
import { getAdminView } from '@/lib/server/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request?: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  return Response.json(await getAdminView(getStore()), { headers: { 'Cache-Control': 'no-store' } });
}
