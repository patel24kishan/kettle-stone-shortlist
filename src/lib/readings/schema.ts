// What Claude returns for one person's lines (build-plan section 6 Step 2, rules.md Step 1).
// Maps 1:1 onto `Reading` in src/lib/types.ts. Kept structured-outputs compatible: plain types, enums,
// nullable (anyOf with null), arrays and strict objects only. No regex, min/max or length constraints
// (the API does not support them); validate.ts checks formats and ranges in code.
import { z } from 'zod';
import { DAYS, THERAPISTS } from '@/lib/types';
import type { Field, Reading, UnclearTopic } from '@/lib/types';

/**
 * Bump this whenever the schema, the prompt or the meaning of a field changes. It is part of the cache
 * key (hash.ts), so a bump makes every person be read again.
 */
export const SCHEMA_VERSION = 'reading-v1';

export const UNCLEAR_TOPICS = ['therapist', 'length', 'day', 'time', 'notice', 'dates'] as const satisfies readonly UnclearTopic[];
export const GONE_VALUES = ['moved', 'not in service', 'going elsewhere'] as const;

export const QuoteSchema = z.strictObject({
  lineId: z.string().describe('The line id the words come from, e.g. "W12".'),
  text: z.string().describe('The exact short words from that line\'s notes. "" for the prenatal field.'),
});

function field<T extends z.ZodType>(value: T, about: string) {
  return z.strictObject({
    value: value.describe(about),
    source: z.array(QuoteSchema).describe('Where the value came from. Empty when the value is the default.'),
  });
}

const TherapistSchema = z.enum(THERAPISTS);
const DaySchema = z.enum(DAYS);
const TimeOrNull = z.string().nullable();
const DateOrNull = z.string().nullable();

/** One schema per Reading field, used by the API schema and by validate.ts field by field. */
export const FIELD_SCHEMAS = {
  therapistsAllowed: field(z.array(TherapistSchema).nullable(), 'Therapists they will see. null = any therapist.'),
  therapistsExcluded: field(z.array(TherapistSchema), 'Therapists they will not see.'),
  lengths: field(
    z.strictObject({
      minutes: z.array(z.number()).describe('Lengths in minutes, e.g. [45, 60].'),
      only: z.boolean().describe('true = only these exact lengths (e.g. "90" or "90 only").'),
    }),
    'Session lengths. Default { minutes: [60], only: false }.',
  ),
  daysAllowed: field(z.array(DaySchema).nullable(), 'Days they can come. null = any day.'),
  daysExcluded: field(z.array(DaySchema), 'Days they cannot come.'),
  startEarliest: field(TimeOrNull, 'Earliest start, "HH:MM" 24h, inclusive. null = no limit.'),
  startLatest: field(TimeOrNull, 'Latest start, "HH:MM" 24h, inclusive. null = no limit.'),
  endBy: field(TimeOrNull, 'Must be finished by, "HH:MM" 24h, inclusive. null = no limit.'),
  noticeHours: field(z.number(), 'Hours of notice needed. Default 2.'),
  nextDayOnly: field(z.boolean(), 'true = must be told on an earlier calendar day.'),
  availableFrom: field(DateOrNull, 'First day they can come, ISO yyyy-mm-dd. null = now.'),
  availableUntil: field(DateOrNull, 'Last day they can come, ISO yyyy-mm-dd. null = no end.'),
  prenatal: field(z.boolean(), 'true = pregnant. Quotes for this field carry the line id and text "".'),
  gone: field(z.enum(GONE_VALUES).nullable(), 'Signs they have gone. null = no sign.'),
} as const;

export type FieldKey = keyof typeof FIELD_SCHEMAS;
export const FIELD_KEYS = Object.keys(FIELD_SCHEMAS) as FieldKey[];

export const UnclearSchema = z.strictObject({
  lineId: z.string(),
  text: z.string().describe('The short words that could not be read (never health words).'),
  affects: z.array(z.enum(UNCLEAR_TOPICS)).describe('Which checks the unreadable part could change.'),
});

export const ReadingSchema = z.strictObject({
  ...FIELD_SCHEMAS,
  unclear: z.array(UnclearSchema).describe('Parts of the notes that could not be read confidently.'),
});

export type ReadingOutput = z.infer<typeof ReadingSchema>;

/**
 * What Claude is asked to return over the wire. The Reading shape above (14 value+source objects with enums and
 * nulls) compiles into a grammar the API rejects as too large, so the answer is flat: plain values, "" or [] in
 * place of null, and one shared quotes list tagged with the field name. `wireToReading` turns it back into the
 * Reading shape, and validate.ts checks every value and quote exactly as before. Same meaning, so SCHEMA_VERSION
 * (and the cache) is unchanged.
 */
export const WireQuoteSchema = z.strictObject({
  field: z.string().describe('The Reading field this quote supports, e.g. "therapistsExcluded", "lengths".'),
  lineId: z.string(),
  text: z.string(),
});

export const WireSchema = z.strictObject({
  therapistsAllowed: z.array(z.string()).describe('Therapist full names. [] = any therapist.'),
  therapistsExcluded: z.array(z.string()),
  lengthMinutes: z.array(z.number()).describe('Default [60].'),
  lengthOnly: z.boolean(),
  daysAllowed: z.array(z.string()).describe('Mon..Sun. [] = any day.'),
  daysExcluded: z.array(z.string()),
  startEarliest: z.string().describe('"HH:MM" or "" for no limit.'),
  startLatest: z.string().describe('"HH:MM" or "" for no limit.'),
  endBy: z.string().describe('"HH:MM" or "" for no limit.'),
  noticeHours: z.number().describe('Default 2.'),
  nextDayOnly: z.boolean(),
  availableFrom: z.string().describe('yyyy-mm-dd or "".'),
  availableUntil: z.string().describe('yyyy-mm-dd or "".'),
  prenatal: z.boolean(),
  gone: z.string().describe('"", "moved", "not in service" or "going elsewhere".'),
  quotes: z.array(WireQuoteSchema),
  unclear: z.array(z.strictObject({ lineId: z.string(), text: z.string(), affects: z.array(z.string()) })),
});

const isWire = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && Array.isArray((raw as { quotes?: unknown }).quotes) && 'lengthMinutes' in raw;

/**
 * Wire answer -> the Reading shape that validateReading expects. Anything that isn't the wire shape (for example an
 * answer already in Reading shape) is passed through untouched, so validation still decides.
 */
export function wireToReading(raw: unknown): unknown {
  if (!isWire(raw)) return raw;
  const w = raw as Record<string, unknown>;
  const quotes = (w.quotes as { field?: unknown; lineId?: unknown; text?: unknown }[]).filter((q) => q && typeof q === 'object');
  const src = (field: string) =>
    quotes.filter((q) => q.field === field).map((q) => ({ lineId: String(q.lineId ?? ''), text: String(q.text ?? '') }));
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const orNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
  const listOrNull = (v: unknown) => (Array.isArray(v) && v.length === 0 ? null : v);
  return {
    therapistsAllowed: { value: listOrNull(w.therapistsAllowed), source: src('therapistsAllowed') },
    therapistsExcluded: { value: list(w.therapistsExcluded), source: src('therapistsExcluded') },
    lengths: { value: { minutes: w.lengthMinutes, only: w.lengthOnly }, source: src('lengths') },
    daysAllowed: { value: listOrNull(w.daysAllowed), source: src('daysAllowed') },
    daysExcluded: { value: list(w.daysExcluded), source: src('daysExcluded') },
    startEarliest: { value: orNull(w.startEarliest), source: src('startEarliest') },
    startLatest: { value: orNull(w.startLatest), source: src('startLatest') },
    endBy: { value: orNull(w.endBy), source: src('endBy') },
    noticeHours: { value: w.noticeHours, source: src('noticeHours') },
    nextDayOnly: { value: w.nextDayOnly, source: src('nextDayOnly') },
    availableFrom: { value: orNull(w.availableFrom), source: src('availableFrom') },
    availableUntil: { value: orNull(w.availableUntil), source: src('availableUntil') },
    prenatal: { value: w.prenatal, source: src('prenatal') },
    gone: { value: orNull(w.gone), source: src('gone') },
    unclear: list(w.unclear),
  };
}

// Compile-time check: the schema's output is a Reading, and a Reading fits the schema.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _schemaMatchesReading: Same<ReadingOutput, Reading> = true;
void _schemaMatchesReading;

/** Which unclear topic a field belongs to (prenatal changes the therapist check; gone/until are dates). */
export const FIELD_TOPIC: Record<FieldKey, UnclearTopic> = {
  therapistsAllowed: 'therapist',
  therapistsExcluded: 'therapist',
  lengths: 'length',
  daysAllowed: 'day',
  daysExcluded: 'day',
  startEarliest: 'time',
  startLatest: 'time',
  endBy: 'time',
  noticeHours: 'notice',
  nextDayOnly: 'notice',
  availableFrom: 'dates',
  availableUntil: 'dates',
  prenatal: 'therapist',
  gone: 'dates',
};

const empty = <T>(value: T): Field<T> => ({ value, source: [] });

/** rules.md Step 1 "If nothing is written": 60 minutes, 2 hours' notice, anything else is fine. */
export function defaultReading(): Reading {
  return {
    therapistsAllowed: empty(null),
    therapistsExcluded: empty([]),
    lengths: empty({ minutes: [60], only: false }),
    daysAllowed: empty(null),
    daysExcluded: empty([]),
    startEarliest: empty(null),
    startLatest: empty(null),
    endBy: empty(null),
    noticeHours: empty(2),
    nextDayOnly: empty(false),
    availableFrom: empty(null),
    availableUntil: empty(null),
    prenatal: empty(false),
    gone: empty(null),
    unclear: [],
  };
}
