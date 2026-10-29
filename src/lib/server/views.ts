// What each screen gets from the server. Pure: built from a RunOutput and the import it came from.
// rules.md "Always": only names, phones, line ids and openings, plus the validated quotes B5 shows; never notes,
// health details or the words behind the clinic rule.
import type { RunOutput } from '@/lib/run';
import { readingCells, unclearText } from '@/lib/format';
import type { ReadingCells } from '@/lib/format';
import { INPUT_KINDS, fileCheckText } from '@/lib/input-files';
import type { InputKind, StoredImport } from '@/lib/storage/types';
import type { Person } from '@/lib/types';

export { FILE_LABELS, INPUT_KINDS, fileCheckText } from '@/lib/input-files';

export interface FileCheck {
  kind: InputKind;
  name: string;
  ok: boolean;
  rows: number;
  missing: string[];
  /** "60 lines · columns OK" or "Missing column(s): notes". */
  check: string;
}

export interface ImportInfo {
  id: string;
  runDate: string;
  createdAt: string;
  /** Latest booked_at date in the booking export ("booked since" is only as current as this). */
  bookingExportDate: string | null;
  files: Record<InputKind, { name: string; sha256: string }>;
}

export function importInfo(imp: StoredImport): ImportInfo {
  return {
    id: imp.id,
    runDate: imp.runDate,
    createdAt: imp.createdAt,
    bookingExportDate: imp.summary.bookingExportDate,
    files: Object.fromEntries(
      INPUT_KINDS.map((k) => [k, { name: imp.files[k].name, sha256: imp.files[k].sha256 }]),
    ) as ImportInfo['files'],
  };
}

export interface AdminPersonRow extends ReadingCells {
  line: string;
  /** "merged W26" (older lines of the same person), or "". */
  merged: string;
  name: string;
  phone: string;
}

export type NotOfferedKind = 'stale' | 'booked' | 'not read' | 'failed' | 'unclear';

export interface NotOfferedRow {
  lineIds: string[];
  name: string;
  /** "W05, W07 Lynn Savoie" */
  who: string;
  kind: NotOfferedKind;
  why: string;
}

export interface AdminCounts {
  linesRead: number;
  peopleReady: number;
  repeatLinesMerged: number;
  staleLines: number;
  /** Active people whose notes were not read (or could not be read). Never offered. */
  notRead: number;
}

export interface AdminView {
  import: ImportInfo;
  files: FileCheck[];
  counts: AdminCounts;
  people: AdminPersonRow[];
  notOffered: NotOfferedRow[];
  /** Shown as a banner when someone's notes were not read; null otherwise. */
  notReadWarning: string | null;
  claudeConnected: boolean;
}

export interface AdminViewOptions {
  /** Whether an Anthropic key is set (changes the not-read warning's wording). */
  claudeConnected?: boolean;
}

const BOOKED_TAIL = ' Kept on file; suggested again only if they add a new line.';

function notOfferedFor(p: Person, run: RunOutput): NotOfferedRow | null {
  const base = { lineIds: p.lineIds, name: p.name, who: `${p.lineIds.join(', ')} ${p.name}` };
  if (p.tags.length > 0) {
    const booked = p.tags.some((t) => t.kind === 'booked');
    const why = p.tags.map((t) => t.reason).join(' ') + (booked ? BOOKED_TAIL : '');
    return { ...base, kind: p.tags.some((t) => t.kind === 'stale') ? 'stale' : 'booked', why };
  }
  const read = run.reads.get(p.key);
  if (!read || read.status === 'not read') return { ...base, kind: 'not read', why: 'Notes not read yet, so not offered.' };
  if (read.status === 'failed' || !read.reading) {
    return { ...base, kind: 'failed', why: 'Notes could not be read, so not offered.' };
  }
  if (read.reading.unclear.length > 0) {
    return { ...base, kind: 'unclear', why: unclearText(read.reading.unclear.flatMap((u) => u.affects)) };
  }
  return null;
}

function notReadWarning(count: number, claudeConnected: boolean): string | null {
  if (count === 0) return null;
  const who = count === 1 ? "1 person's notes weren't read" : `${count} people's notes weren't read`;
  return claudeConnected
    ? `${who} because Claude could not read them; they won't be suggested. Import again to retry.`
    : `${who} because Claude isn't connected; they won't be suggested.`;
}

const firstLineN = (p: Person, run: RunOutput) => run.lines.find((l) => l.id === p.lineIds[0])?.n ?? 0;

/** What B5 shows for the latest import. */
export function adminView(run: RunOutput, imp: StoredImport, opts: AdminViewOptions = {}): AdminView {
  const claudeConnected = opts.claudeConnected ?? false;
  const people: AdminPersonRow[] = [];
  const notOffered: { n: number; row: NotOfferedRow }[] = [];

  for (const p of run.people) {
    const blocked = notOfferedFor(p, run);
    if (blocked) {
      notOffered.push({ n: firstLineN(p, run), row: blocked });
      continue;
    }
    const reading = run.reads.get(p.key)!.reading!;
    people.push({
      line: p.newestId,
      merged: p.lineIds.length > 1 ? `merged ${p.lineIds.filter((id) => id !== p.newestId).join(', ')}` : '',
      name: p.name,
      phone: p.phoneDisplay,
      ...readingCells(reading, p.newestId),
    });
  }

  const s = run.summary;
  const notRead = s.notRead.length + s.failed.length;
  return {
    import: importInfo(imp),
    files: INPUT_KINDS.map((kind) => ({
      kind,
      name: imp.files[kind].name,
      ok: true,
      rows: imp.summary.rows[kind],
      missing: [],
      check: fileCheckText(kind, imp.summary.rows[kind], []),
    })),
    counts: {
      linesRead: s.linesRead,
      peopleReady: people.length,
      repeatLinesMerged: s.duplicates,
      staleLines: s.stale,
      notRead,
    },
    people: people.sort((a, b) => lineN(a.line) - lineN(b.line)),
    notOffered: notOffered.sort((a, b) => a.n - b.n).map((x) => x.row),
    notReadWarning: notReadWarning(notRead, claudeConnected),
    claudeConnected,
  };
}

const lineN = (id: string) => Number(id.replace(/\D/g, '')) || 0;
