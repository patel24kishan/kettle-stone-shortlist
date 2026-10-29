// Code checks what Claude returned (build-plan section 6 Step 2: "Code checks the JSON: the schema, allowed
// values, and that each quote really appears in the notes. Anything that fails ... is marked unclear ...
// never guessed"). A field that fails is reset to its default with an empty source AND gets an unclear
// entry for its topic, so the matcher never offers that person where the field could matter.
// Problem messages go to B5: they name the field and line id, never the quoted words (no health details).
import { DAYS, THERAPISTS } from '@/lib/types';
import type { Reading, UnclearTopic, WaitlistLine } from '@/lib/types';
import { daysInMonth } from '@/lib/normalise';
import {
  FIELD_KEYS,
  FIELD_SCHEMAS,
  FIELD_TOPIC,
  UNCLEAR_TOPICS,
  UnclearSchema,
  defaultReading,
} from '@/lib/readings/schema';
import type { FieldKey } from '@/lib/readings/schema';

/**
 * Health words that must never appear in a quote (rules.md "Always": no health details anywhere).
 * Matched as whole words, case-insensitive, with an optional plural "s".
 */
export const HEALTH_WORDS = [
  'pregnant', 'pregnancy', 'prenatal', 'surgery', 'post-op', 'op', 'replacement', 'MVA', 'sciatica',
  'cancer', 'fibro', 'concussion', 'migraine', 'TMJ', 'knee', 'hip', 'shoulder', 'back', 'injury', 'claim',
  'rotator', 'cuff', 'hamstring', 'survivor',
] as const;

const HEALTH_RE = new RegExp(
  `(^|[^a-z0-9])(${HEALTH_WORDS.map((w) => w.toLowerCase().replace(/[-]/g, '\\-')).join('|')})s?(?=$|[^a-z0-9])`,
  'i',
);

export function hasHealthWord(text: string): boolean {
  return HEALTH_RE.test(norm(text));
}

/** Lowercase, NFC, single spaces, trimmed. Used to check a quote is in the notes. */
export function norm(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function unique<T>(xs: readonly T[]): boolean {
  return new Set(xs).size === xs.length;
}

/** Extra value checks beyond the zod shape. Returns a reason, or null when the value is fine. */
function valueProblem(key: FieldKey, value: unknown): string | null {
  switch (key) {
    case 'therapistsAllowed':
    case 'therapistsExcluded': {
      if (value === null) return null;
      const list = value as string[];
      if (key === 'therapistsAllowed' && list.length === 0) return 'an empty therapist list';
      if (!list.every((t) => (THERAPISTS as readonly string[]).includes(t))) return 'an unknown therapist';
      return unique(list) ? null : 'a therapist listed twice';
    }
    case 'daysAllowed':
    case 'daysExcluded': {
      if (value === null) return null;
      const list = value as string[];
      if (key === 'daysAllowed' && list.length === 0) return 'an empty day list';
      if (!list.every((d) => (DAYS as readonly string[]).includes(d))) return 'an unknown day';
      return unique(list) ? null : 'a day listed twice';
    }
    case 'lengths': {
      const { minutes } = value as { minutes: number[] };
      if (minutes.length === 0) return 'no length';
      if (!minutes.every((m) => Number.isInteger(m) && m >= 15 && m <= 240)) return 'a length that is not 15 to 240 whole minutes';
      return unique(minutes) ? null : 'a length listed twice';
    }
    case 'startEarliest':
    case 'startLatest':
    case 'endBy':
      return value === null || TIME_RE.test(value as string) ? null : 'a time that is not HH:MM (24 h)';
    case 'availableFrom':
    case 'availableUntil':
      return value === null || isIsoDate(value as string) ? null : 'a date that is not yyyy-mm-dd';
    case 'noticeHours': {
      const n = value as number;
      return Number.isFinite(n) && n >= 0 && n <= 168 ? null : 'a notice that is not 0 to 168 hours';
    }
    default:
      return null;
  }
}

interface LineIndex {
  ids: Set<string>;
  notes: Map<string, string>; // id -> normalised notes
  newestId: string;
}

function indexLines(lines: WaitlistLine[]): LineIndex {
  return {
    ids: new Set(lines.map((l) => l.id)),
    notes: new Map(lines.map((l) => [l.id, norm(l.notes)])),
    newestId: lines[lines.length - 1]?.id ?? '',
  };
}

/** Checks one quote. `prenatal` quotes must carry an empty text (the words are never kept). */
function quoteProblem(q: { lineId: string; text: string }, idx: LineIndex, prenatal: boolean): string | null {
  if (!idx.ids.has(q.lineId)) return `a quote names line ${JSON.stringify(q.lineId)}, which is not one of this person's lines`;
  if (prenatal) return q.text === '' ? null : `a quote on ${q.lineId} carries words (prenatal quotes must be empty)`;
  if (norm(q.text) === '') return `a quote on ${q.lineId} is empty`;
  if (hasHealthWord(q.text)) return `a quote on ${q.lineId} contains a health word`;
  if (!idx.notes.get(q.lineId)!.includes(norm(q.text))) return `a quote on ${q.lineId} is not in that line's notes`;
  return null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validates Claude's raw output for one person's lines. Never throws.
 * Returns a Reading in which every field either passed every check or is the default value marked unclear.
 */
export function validateReading(raw: unknown, lines: WaitlistLine[]): { reading: Reading; problems: string[] } {
  const idx = indexLines(lines);
  const defaults = defaultReading();
  const problems: string[] = [];
  const out = defaultReading() as unknown as Record<string, unknown>;
  const unclear: Reading['unclear'] = [];
  const markUnclear = (topic: UnclearTopic) => {
    if (!unclear.some((u) => u.text === '' && u.lineId === idx.newestId && u.affects.includes(topic))) {
      unclear.push({ lineId: idx.newestId, text: '', affects: [topic] });
    }
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('The reading is not a JSON object; every topic is marked unclear.');
    for (const t of UNCLEAR_TOPICS) markUnclear(t);
    return { reading: { ...defaults, unclear }, problems };
  }
  const obj = raw as Record<string, unknown>;

  const known = new Set<string>([...FIELD_KEYS, 'unclear']);
  for (const k of Object.keys(obj)) if (!known.has(k)) problems.push(`Unknown field "${k}" ignored.`);

  for (const key of FIELD_KEYS) {
    const fail = (why: string) => {
      problems.push(`${key}: ${why}; set to the default and marked unclear (${FIELD_TOPIC[key]}).`);
      markUnclear(FIELD_TOPIC[key]);
    };
    const parsed = FIELD_SCHEMAS[key].safeParse(obj[key]);
    if (!parsed.success) {
      fail(obj[key] === undefined ? 'missing' : 'not the expected shape or an unknown value');
      continue;
    }
    const f = parsed.data as { value: unknown; source: { lineId: string; text: string }[] };
    const vp = valueProblem(key, f.value);
    if (vp) {
      fail(vp);
      continue;
    }
    const qp = f.source.map((q) => quoteProblem(q, idx, key === 'prenatal')).find((p) => p !== null);
    if (qp) {
      fail(qp);
      continue;
    }
    const isDefault = sameJson(f.value, (defaults as unknown as Record<string, { value: unknown }>)[key]!.value);
    if (!isDefault && f.source.length === 0) {
      fail('a value other than the default with no quote');
      continue;
    }
    out[key] = { value: f.value, source: f.source.map((q) => ({ lineId: q.lineId, text: q.text })) };
  }

  // Claude's own unclear entries. A bad entry is never dropped (that would lose a flag): its line id falls
  // back to the newest line, its words are blanked, and unknown topics become every topic.
  const rawUnclear = obj.unclear;
  if (!Array.isArray(rawUnclear)) {
    problems.push('unclear: missing or not a list; every topic is marked unclear.');
    for (const t of UNCLEAR_TOPICS) markUnclear(t);
  } else {
    rawUnclear.forEach((entry, i) => {
      const parsed = UnclearSchema.safeParse(entry);
      if (!parsed.success) {
        const affects = Array.isArray((entry as { affects?: unknown })?.affects)
          ? ((entry as { affects: unknown[] }).affects.filter((a) =>
              (UNCLEAR_TOPICS as readonly unknown[]).includes(a),
            ) as UnclearTopic[])
          : [];
        problems.push(`unclear[${i}]: not the expected shape; kept as unclear.`);
        unclear.push({ lineId: idx.newestId, text: '', affects: affects.length ? affects : [...UNCLEAR_TOPICS] });
        return;
      }
      const u = parsed.data;
      let lineId = u.lineId;
      let text = u.text;
      if (!idx.ids.has(lineId)) {
        problems.push(`unclear[${i}]: names a line that is not one of this person's lines; moved to ${idx.newestId}.`);
        lineId = idx.newestId;
        text = '';
      } else if (text !== '' && hasHealthWord(text)) {
        problems.push(`unclear[${i}]: the words contain a health word; words removed.`);
        text = '';
      } else if (text !== '' && !idx.notes.get(lineId)!.includes(norm(text))) {
        problems.push(`unclear[${i}]: the words are not in ${lineId}'s notes; words removed.`);
        text = '';
      }
      const affects = u.affects.length ? [...new Set(u.affects)] : [...UNCLEAR_TOPICS];
      if (!u.affects.length) problems.push(`unclear[${i}]: no topic given; every topic is marked unclear.`);
      unclear.push({ lineId, text, affects });
    });
  }

  return { reading: { ...(out as unknown as Reading), unclear }, problems };
}
