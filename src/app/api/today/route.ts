// GET /api/today?date=YYYY-MM-DD (Screen 3, Today's openings): that date's late openings from the imported file,
// in start-time order, each as the Search screen's display model (up to 3 names, nobody, or filled), plus
// { date, dateLabel, count, dates: { first, last }, context }.
// 400 { ok: false, message } for a missing or invalid date; 409 { ok: false, noImport: true } before the first import.
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore } from '@/lib/storage';
import { todayOpenings } from '@/lib/server/today-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  const date = new URL(request.url).searchParams.get('date');
  const result = await todayOpenings(getStore(), date);
  if (!result.ok) {
    const { status, ...rest } = result;
    return Response.json(rest, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
