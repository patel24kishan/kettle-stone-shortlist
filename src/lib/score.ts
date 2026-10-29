// The scorer (build-plan.md section 6 Step 5 and section 7). Reads results.csv, line_verdicts.csv and Tanya's
// answer key and says how close we are. Test tool only: it reads text and returns text, it never writes a file.
//
// How Friday scores (build-plan.md section 1): an opening is a match when every name we show is on the key's
// list for it, or when we show nobody and the key says nobody. Order does not count and fewer than 3 is fine.
// The stricter extra check: our names equal the key's first 3, in order.
// Names are compared by line id only (W39), never by name: our output uses the waitlist spelling ("Joel"),
// the key uses "Joël". The key on Friday covers only the 10 new openings, so a key that covers a subset is normal.
import Papa from 'papaparse';
import { REQUIRED_COLUMNS } from '@/lib/csv';

// ---- reading the files -----------------------------------------------------------------------------------

interface Table {
  rows: Record<string, string>[];
}

/** Header row + data rows, tolerant of quoting and a BOM. Throws when a required column is missing. */
function readTable(text: string, required: readonly string[], label: string): Table {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const res = Papa.parse<Record<string, string>>(clean, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
  const found = new Set(res.meta.fields ?? []);
  const missing = required.filter((c) => !found.has(c));
  if (missing.length > 0) throw new Error(`The ${label} file is missing column(s): ${missing.join(', ')}.`);
  return { rows: res.data };
}

const cell = (row: Record<string, string>, key: string): string => (row[key] ?? '').trim();

const normaliseId = (id: string): string => id.trim().toUpperCase();

/**
 * "W46 Shawn Duguay (506-555-0140); W53 Luc Bernard (506-555-0121)" -> ["W46", "W53"]; "none" -> [].
 * Only the line id of each entry is kept. `where` names the row for the error message.
 */
function parseShortlist(raw: string, where: string): string[] {
  const text = raw.trim();
  if (text === '') throw new Error(`${where}: the shortlist is empty (expected names, or "none").`);
  if (text.toLowerCase() === 'none') return [];
  const ids: string[] = [];
  for (const part of text.split(';')) {
    const entry = part.trim();
    if (entry === '') continue; // a trailing ";"
    const m = /^(W\d+)(?=\s|$)/i.exec(entry);
    if (!m) {
      throw new Error(`${where}: cannot read the shortlist entry "${entry}" (each entry must start with a line id such as W46, or the whole cell must be "none").`);
    }
    ids.push(normaliseId(m[1]!));
  }
  if (ids.length === 0) throw new Error(`${where}: the shortlist has no names (expected names, or "none").`);
  return ids;
}

/** results.csv (`opening_id,shortlist`) -> opening id -> line ids (empty = none). */
export function parseResultsCsv(text: string): Map<string, string[]> {
  const { rows } = readTable(text, ['opening_id', 'shortlist'], 'results');
  const out = new Map<string, string[]>();
  rows.forEach((row, i) => {
    const id = cell(row, 'opening_id');
    if (id === '') throw new Error(`results file, data row ${i + 1}: opening_id is empty.`);
    if (out.has(id)) throw new Error(`results file: opening ${id} appears more than once.`);
    out.set(id, parseShortlist(row.shortlist ?? '', `results file, opening ${id}`));
  });
  return out;
}

export interface AnswerKey {
  /** opening id -> every line id that fits, in list order (empty = nobody). */
  openings: Map<string, string[]>;
  /** waitlist line id -> verdict as Tanya wrote it (`active`, `stale`, `duplicate of W51`). */
  lines: Map<string, string>;
}

export function parseAnswerKey(text: string): AnswerKey {
  const { rows } = readTable(text, REQUIRED_COLUMNS.answerKey, 'answer key');
  const openings = new Map<string, string[]>();
  const lines = new Map<string, string>();
  for (const row of rows) {
    const id = cell(row, 'id');
    const type = cell(row, 'type').toLowerCase();
    if (type === 'opening') {
      if (openings.has(id)) throw new Error(`answer key: opening ${id} appears more than once.`);
      openings.set(id, parseShortlist(row.answer ?? '', `answer key, opening ${id}`));
    } else if (type === 'waitlist line') {
      const lineId = normaliseId(id);
      if (lines.has(lineId)) throw new Error(`answer key: line ${lineId} appears more than once.`);
      const verdict = cell(row, 'answer');
      if (verdict === '') throw new Error(`answer key, line ${lineId}: the answer is empty.`);
      lines.set(lineId, verdict);
    }
    // any other type is ignored
  }
  if (openings.size === 0 && lines.size === 0) {
    throw new Error('The answer key has no opening rows and no waitlist line rows.');
  }
  return { openings, lines };
}

/** line_verdicts.csv (`line,verdict,reason`) -> line id -> verdict. */
export function parseLineVerdictsCsv(text: string): Map<string, string> {
  const { rows } = readTable(text, ['line', 'verdict'], 'line verdicts');
  const out = new Map<string, string>();
  rows.forEach((row, i) => {
    const id = normaliseId(cell(row, 'line'));
    if (id === '') throw new Error(`line verdicts file, data row ${i + 1}: line is empty.`);
    if (out.has(id)) throw new Error(`line verdicts file: line ${id} appears more than once.`);
    out.set(id, cell(row, 'verdict'));
  });
  return out;
}

// ---- scoring ---------------------------------------------------------------------------------------------

export interface OpeningScore {
  id: string;
  /** Line ids we showed (empty = nobody, or missing). */
  ours: string[];
  /** Line ids on Tanya's list, in her order (empty = nobody). */
  theirs: string[];
  fridayMatch: boolean;
  first3Match: boolean;
  /** Short plain reason when not a Friday match; null when it matches. */
  problem: string | null;
  /** True when results.csv had no row for this opening. */
  missing: boolean;
}

export interface OpeningTotals {
  openings: number;
  fridayMatches: number;
  first3Matches: number;
}

export interface OpeningsResult {
  scores: OpeningScore[];
  totals: OpeningTotals;
  /** Openings in results.csv that the key does not cover. Not scored. */
  notInKey: string[];
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function scoreOpenings(results: Map<string, string[]>, key: AnswerKey): OpeningsResult {
  const scores: OpeningScore[] = [];
  for (const [id, theirs] of key.openings) {
    const found = results.get(id);
    const ours = found ?? [];
    const onList = new Set(theirs);
    const wrong = [...new Set(ours.filter((l) => !onList.has(l)))];

    let problem: string | null = null;
    if (found === undefined) {
      problem = 'missing from results.csv';
    } else if (ours.length === 0 && theirs.length > 0) {
      problem = `we showed nobody but Tanya has ${theirs.length}`;
    } else if (ours.length > 0 && theirs.length === 0) {
      problem = `we showed ${ours.length} ${plural(ours.length, 'name', 'names')} but Tanya says nobody`;
    } else if (wrong.length > 0) {
      problem = `${wrong.join(', ')} ${plural(wrong.length, 'is', 'are')} not on Tanya's list`;
    }

    const first3 = theirs.slice(0, 3);
    scores.push({
      id,
      ours,
      theirs,
      fridayMatch: problem === null,
      first3Match: found !== undefined && ours.length === first3.length && ours.every((l, i) => l === first3[i]),
      problem,
      missing: found === undefined,
    });
  }
  return {
    scores,
    totals: {
      openings: scores.length,
      fridayMatches: scores.filter((s) => s.fridayMatch).length,
      first3Matches: scores.filter((s) => s.first3Match).length,
    },
    notInKey: [...results.keys()].filter((id) => !key.openings.has(id)),
  };
}

export interface LineScore {
  id: string;
  /** Our verdict ("" when line_verdicts.csv has no row for it). */
  ours: string;
  /** Tanya's verdict. */
  theirs: string;
  match: boolean;
}

export interface LinesResult {
  scores: LineScore[];
  totals: { lines: number; matches: number };
  /** Lines in line_verdicts.csv that the key does not cover. Not scored. */
  notInKey: string[];
}

const normaliseVerdict = (v: string): string => v.trim().replace(/\s+/g, ' ').toLowerCase();

export function scoreLines(verdicts: Map<string, string>, key: AnswerKey): LinesResult {
  const scores: LineScore[] = [];
  for (const [id, theirs] of key.lines) {
    const ours = verdicts.get(id) ?? '';
    scores.push({ id, ours, theirs, match: normaliseVerdict(ours) === normaliseVerdict(theirs) });
  }
  return {
    scores,
    totals: { lines: scores.length, matches: scores.filter((s) => s.match).length },
    notInKey: [...verdicts.keys()].filter((id) => !key.lines.has(id)),
  };
}

// ---- the report ------------------------------------------------------------------------------------------

const names = (ids: string[]): string => (ids.length === 0 ? 'nobody' : ids.join(' '));

/** Tanya's list is long for busy openings: show the first 3 and how many more, unless the full list explains a miss. */
function theirList(s: OpeningScore): string {
  if (s.theirs.length <= 3 || !s.fridayMatch) return names(s.theirs);
  return `${s.theirs.slice(0, 3).join(' ')} (+${s.theirs.length - 3} more)`;
}

export function formatReport(openings: OpeningsResult, lines: LinesResult | null): string {
  const out: string[] = [];
  const idWidth = Math.max(3, ...openings.scores.map((s) => s.id.length));

  for (const s of openings.scores) {
    const id = s.id.padEnd(idWidth);
    const body = `ours ${names(s.ours)} | Tanya ${theirList(s)}`;
    if (!s.fridayMatch) {
      out.push(`${id}  MISMATCH  ${body}   <-- ${s.problem}`);
    } else if (!s.first3Match) {
      out.push(`${id}  match     ${body}   (not Tanya's first 3)`);
    } else {
      out.push(`${id}  match     ${body}`);
    }
  }
  if (openings.notInKey.length > 0) {
    out.push('');
    out.push(`Not in the key, so not scored (${openings.notInKey.length}): ${openings.notInKey.join(', ')}`);
  }

  if (lines) {
    const bad = lines.scores.filter((l) => !l.match);
    if (bad.length > 0) {
      out.push('');
      for (const l of bad) {
        out.push(`${l.id}  MISMATCH  ours ${l.ours === '' ? '(no verdict)' : l.ours} | Tanya ${l.theirs}`);
      }
    }
  }

  const t = openings.totals;
  out.push('');
  out.push(`Openings: ${t.fridayMatches}/${t.openings} match (Friday rule) · ${t.first3Matches}/${t.openings} equal Tanya's first 3`);
  if (lines === null) {
    out.push('Lines: not scored (no line verdicts file)');
  } else if (lines.totals.lines === 0) {
    out.push('Lines: not scored (the key has no waitlist line rows)');
  } else {
    out.push(`Lines: ${lines.totals.matches}/${lines.totals.lines}`);
  }
  return `${out.join('\n')}\n`;
}
