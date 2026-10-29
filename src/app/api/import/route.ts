// POST /api/import (B5 "Import and analyse"): multipart form with the files `waitlist`, `openings`,
// `appointments` and the field `runDate`. 200 { ok, import, view }; 400 { ok: false, message, problems, files }.
import { requireStaff } from '@/lib/supabase/require-staff';
import { getStore } from '@/lib/storage';
import { defaultClaudeClient } from '@/lib/server/claude-client';
import { importFiles } from '@/lib/server/import-service';
import type { InputFile } from '@/lib/server/import-service';
import type { InputKind } from '@/lib/storage/types';
import { FILE_LABELS, INPUT_KINDS } from '@/lib/server/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Claude reads new people in parallel batches during the import (build-plan section 4: serverless time limits).
export const maxDuration = 300;

const bad = (message: string) =>
  Response.json({ ok: false, message, problems: [], files: [] }, { status: 400 });

function isFile(v: FormDataEntryValue | null): v is File {
  return v !== null && typeof v === 'object' && typeof (v as File).text === 'function';
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireStaff(request);
  if (denied) return denied;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad('Send the three CSV files as a form (multipart/form-data).');
  }

  const files = {} as Record<InputKind, InputFile>;
  const missing: string[] = [];
  for (const kind of INPUT_KINDS) {
    const entry = form.get(kind);
    if (!isFile(entry) || entry.size === 0) {
      missing.push(FILE_LABELS[kind].label);
      continue;
    }
    files[kind] = { name: entry.name || `${kind}.csv`, text: await entry.text() };
  }
  if (missing.length > 0) return bad(`Choose a file for: ${missing.join(', ')}.`);

  const runDate = String(form.get('runDate') ?? '').trim();
  if (!runDate) return bad('Choose a run date.');

  const result = await importFiles({ ...files, runDate }, { store: getStore(), client: defaultClaudeClient() });
  if (!result.ok) return Response.json(result, { status: 400 });
  return Response.json({ ok: true, import: result.import, view: result.view });
}
