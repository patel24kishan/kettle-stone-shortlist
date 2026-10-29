// GET /api/line-verdicts.csv: line,verdict,reason for every waitlist line of the current run (same as the CLI).
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore } from '@/lib/storage';
import { getLineVerdictsCsv } from '@/lib/server/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request?: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  const file = await getLineVerdictsCsv(getStore());
  if (!file) {
    return Response.json({ empty: true, message: 'Nothing imported yet.' }, { status: 404 });
  }
  return new Response(file.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="line_verdicts-${file.runDate}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
