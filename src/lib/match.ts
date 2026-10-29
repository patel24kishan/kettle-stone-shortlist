// The matcher: rules.md Step 3 (every check must pass, waitlist as it stands on the run date) and
// Step 4 (waitlist order, first 3). Pure code, no AI. Reference: build-plan.md section 5.4.
import { CHECKS } from '@/lib/rules';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { CheckResult, Opening, OpeningResult, Person, Reading, Settings } from '@/lib/types';

export const NO_SHOW_REASON = 'No-show: there is no time to offer it.';
export const NOBODY_REASON = 'No one on the waitlist can take this opening.';
export const MAX_SUGGESTIONS = 3;

/** Readings by person key (newest line id), as returned by readAll. Missing or null = notes not read. */
export type ReadingsByKey = Map<string, Reading | null>;

function runChecks(opening: Opening, person: Person, reading: Reading | null, settings: Settings): CheckResult[] {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    const r = check({ opening, person, reading, settings });
    results.push(r);
    if (!r.pass) break; // the first failure ends this person's trace
  }
  return results;
}

const allPass = (checks: CheckResult[]): boolean => checks.length === CHECKS.length && checks.every((c) => c.pass);

export function matchOpening(
  opening: Opening,
  people: Person[],
  readings: ReadingsByKey,
  settings: Settings = DEFAULT_SETTINGS,
): OpeningResult {
  const joseeNote = opening.therapist === 'Josée Landry';
  if (opening.kind === 'no-show') {
    return { openingId: opening.opening_id, suggestions: [], nobodyReason: NO_SHOW_REASON, joseeNote, trace: [] };
  }

  // Waitlist order: the person's newest line, smallest first. No filtering by line date (rules.md Step 3).
  const ordered = [...people].sort((a, b) => a.newestN - b.newestN);
  const trace = ordered.map((p) => ({
    lineId: p.newestId,
    checks: runChecks(opening, p, readings.get(p.key) ?? null, settings),
  }));
  const passing = new Set(trace.filter((t) => allPass(t.checks)).map((t) => t.lineId));
  const suggestions = ordered
    .filter((p) => passing.has(p.newestId))
    .slice(0, MAX_SUGGESTIONS)
    .map((p) => ({ lineId: p.newestId, name: p.name, phoneDisplay: p.phoneDisplay }));

  return {
    openingId: opening.opening_id,
    suggestions,
    nobodyReason: suggestions.length === 0 ? NOBODY_REASON : null,
    joseeNote,
    trace,
  };
}

export function matchAll(
  openings: Opening[],
  people: Person[],
  readings: ReadingsByKey,
  settings: Settings = DEFAULT_SETTINGS,
): OpeningResult[] {
  return openings.map((o) => matchOpening(o, people, readings, settings));
}

/** Every person who passed all checks, in waitlist order (not just the first 3). For tests and the scorer. */
export function passingIds(result: OpeningResult): string[] {
  return result.trace.filter((t) => allPass(t.checks)).map((t) => t.lineId);
}
