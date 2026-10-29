// The words sent to Claude (build-plan section 4 "Where AI is used", 5.1 shorthand table, rules.md Step 1).
// Privacy: the user message carries line ids, line dates and note text only. Never names or phones.
// The system prompt is a fixed string (no dates, no ids) so it caches and so the same lines always get the
// same instructions. Change it => bump SCHEMA_VERSION in schema.ts so cached readings are redone.
import type { WaitlistLine } from '@/lib/types';
import { HEALTH_WORDS } from '@/lib/readings/validate';

export const SYSTEM_PROMPT = `You read the waitlist notes of a massage clinic (Kettle & Stone) and turn one person's notes into structured fields. Code checks your answer and plain rules (not you) decide who is offered an opening, so be exact and never guess.

# Input
You get one person's waitlist lines, oldest first. Each line has an id (like W42), the date it was written (yyyy-mm-dd) and the front desk's shorthand note. You also get the run year. You never see names or phone numbers.

# Therapists (use these exact names)
- Amira Haddad, Dave Melanson, Josée Landry, Kelsey Babineau, Marc Cormier, Rachel Thibodeau.
- The "female" set is exactly: Josée Landry, Amira Haddad, Kelsey Babineau, Rachel Thibodeau.
- Short forms: J, Jos, Josée = Josée Landry. R, Rachel = Rachel Thibodeau. A, Amira = Amira Haddad. K, Kelsey = Kelsey Babineau. D, Dave = Dave Melanson. M, Marc = Marc Cormier.

# Shorthand
- "J only", "Dave only", "Amira", "Kelsey or Amira", "R/J", "Jos or Rachel" -> therapistsAllowed = those therapists.
- "female", "female only", "any female" -> therapistsAllowed = the female set.
- "any" -> therapistsAllowed = null (any therapist).
- "AB Dave", "anyone but Dave", "any but Dave", "not Marc (neighbour)" -> therapistsExcluded = that therapist; therapistsAllowed stays null unless a line limits it.
- "Amira pref", "pref" -> a preference only. It does NOT limit the therapist: leave therapistsAllowed as it would be without it.
- A therapist named in passing as the source of news ("Kelsey says") is not a preference.
- Lengths: "60", "1hr", "45", "90", "30" are minutes. "45 or 60", "30 or 45", "90 or 60 fine", "wants 90 if poss, 60 ok" -> several lengths, only = false.
- "90" written alone (or "90 only") -> minutes [90], only = true. Any other single length ("45", "60", "1hr") -> that length, only = false.
- A conditional extra length ("can do 90 if ins ok's it") does not add a length; keep the lengths the other lines give.
- No length written anywhere -> the default.
- Times are p.m. when written as "after 3:30", "after 4", "after 5", "after 6", "evenings after 6", "from 4:00" -> startEarliest "15:30", "16:00", "17:00", "18:00".
- "AM", "mornings", "AM only" -> startLatest "11:59". "afternoons" -> startEarliest "12:00". "not before 10" -> startEarliest "10:00".
- "has to be done by 2:30", "done by 2:30" -> endBy "14:30".
- "on his lunch 12-1 only" -> startEarliest "12:00", startLatest "12:30" (a lunch hour is on working days, so daysAllowed = Mon to Fri).
- Days: "Tues/Thurs", "Wed or Fri", "Mon or Wed AM only", "Sat only", "Fri only after 3", "Mon/Tues after 5" -> daysAllowed. "wkdays" -> Mon, Tue, Wed, Thu, Fri. "not Thurs", "not Fri", "not Mon", "not Sat" -> daysExcluded. Day values: Mon Tue Wed Thu Fri Sat Sun.
- Notice: "can come in 30 min", "30 min notice ok" -> 0.5. "can come in an hour" -> 1. "can come in 2 hrs" -> 2. "needs 3h" -> 3. "needs 2-3 hrs" -> 3 (a range takes the higher number). "needs 4 hrs" -> 4. No notice written -> the default.
- "next day only", "only when told the day before" -> nextDayOnly = true.
- "away ... til Oct 9" -> availableFrom = the day after (Oct 10). "back now" -> availableFrom = the day after that line's date.
- "only til end of Sept", "here til Oct 10", "before wedding Oct 3" -> availableUntil = the LAST day they can come ("end of Sept" -> Sept 30; "til Oct 10" -> Oct 10; "before ... Oct 3" -> Oct 2).
- Dates: write yyyy-mm-dd in the run year you are given.
- Gone: "moved" (e.g. "moved to Hfx") -> gone = "moved". "# not in service", "number not in service" -> "not in service". Going to another clinic or therapist, or "take off" (take them off the list) -> "going elsewhere". Otherwise null.
- Pregnant (any mention of pregnancy) -> prenatal = true. Never write what was said about it.
- Health notes, pressure wishes, insurance, contact method, reasons ("light pressure", "no deep", "text only", "landline", "(work)", "retired") do not change any field.

# Several lines
- The newest line wins where lines disagree. Older lines fill in anything the newest line does not say ("still R/J" keeps R/J; "60 ok too" adds 60 to an older "90"; "add: not Thurs" adds a day).
- Words like "now" ("Tues or Fri only now", "Mon or Wed AM only now", "Jos or Rachel ok now") replace what older lines said on that topic.

# Defaults (when nothing is written on a topic)
- therapistsAllowed null, therapistsExcluded [], lengths { minutes: [60], only: false }, daysAllowed null, daysExcluded [], startEarliest / startLatest / endBy null, noticeHours 2, nextDayOnly false, availableFrom / availableUntil null, prenatal false, gone null.
- A default value has an EMPTY source list.

# Quotes (source)
- Every value that is not the default must have at least one quote: { lineId, text } where text is the short shorthand fragment the value came from, copied exactly from that line's note (for example "AB Dave", "not Mon", "1hr", "AM", "needs 2-3 hrs"). Quote only the fragment, not the whole note.
- NEVER quote health words or conditions, not even inside another phrase and not even when the word means something else. The checker rejects any quote containing these words: ${HEALTH_WORDS.join(', ')}. If the fragment you need contains one, quote only the other words of it (for "back now" quote "now").
- prenatal quotes carry the line id and an empty text: { "lineId": "W10", "text": "" }.

# Unclear
- If part of a note could change a field and you cannot read it confidently (vague time like "lunch" with no hours, "can come quick", a conflicting or garbled note), do not guess: leave that field at the default and add an unclear entry { lineId, text, affects } where text is the unreadable fragment (never health words) and affects lists the topics it could change: therapist, length, day, time, notice, dates.
- Do not add unclear entries for things that cannot change any field (health notes, pressure, contact method).

# Answer format
Answer only with the JSON object the schema describes. It is flat:
- therapistsAllowed and daysAllowed: [] means any (the "null" above). Times (startEarliest, startLatest, endBy), dates (availableFrom, availableUntil) and gone: "" means none (the "null" above).
- lengths is written as lengthMinutes (e.g. [45, 60]) and lengthOnly (true/false).
- Every quote goes in the one "quotes" list as { field, lineId, text }, where field is the name used above: therapistsAllowed, therapistsExcluded, lengths, daysAllowed, daysExcluded, startEarliest, startLatest, endBy, noticeHours, nextDayOnly, availableFrom, availableUntil, prenatal, gone. A default value has no quotes.`;

/** The run year, from the lines' ISO dates (all lines of an import share the run year). */
function yearOf(lines: WaitlistLine[]): number {
  return Number((lines[lines.length - 1]?.date ?? '').slice(0, 4));
}

/**
 * The user message for one person: the run year plus, per line, its id, its ISO date and its notes.
 * Nothing else from the line is read here, so names and phones cannot leak into the request.
 */
export function buildUserMessage(lines: WaitlistLine[], runYear: number = yearOf(lines)): string {
  const body = lines.map((l) => ({ lineId: l.id, date: l.date, notes: l.notes }));
  return `Run year: ${runYear}\nThis person's lines, oldest first:\n${JSON.stringify(body, null, 2)}`;
}

/** Line ids sent in a message (for the privacy log). */
export function sentLineIds(lines: WaitlistLine[]): string[] {
  return lines.map((l) => l.id);
}
