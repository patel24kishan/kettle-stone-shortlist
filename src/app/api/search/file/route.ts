// POST /api/search/file (A1b, all openings from a file): multipart form with an optional `openings` CSV.
// No file = the late openings file of the latest import. 200 { ok, source, fileName, check, openings, counts,
// resultsCsv, context }; 400 { ok: false, message, problems, check } when columns are missing; 409 before the
// first import.
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore } from '@/lib/storage';
import { searchFile } from '@/lib/server/search-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function isFile(v: FormDataEntryValue | null): v is File {
  return v !== null && typeof v === 'object' && typeof (v as File).text === 'function';
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  let text: string | null = null;
  let name: string | undefined;
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return Response.json(
        { ok: false, message: 'Send the late openings CSV as a form (multipart/form-data).', problems: [] },
        { status: 400, headers: NO_STORE },
      );
    }
    const entry = form.get('openings');
    if (isFile(entry) && entry.size > 0) {
      text = await entry.text();
      name = entry.name || 'openings.csv';
    }
  }
  const result = await searchFile(getStore(), text, name);
  if (!result.ok) {
    const { status, ...rest } = result;
    return Response.json(rest, { status, headers: NO_STORE });
  }
  return Response.json(result, { headers: NO_STORE });
}
