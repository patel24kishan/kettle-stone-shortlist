// All checks, in the order they are run for each person (rules.md Step 3). The first failure ends a person's trace.
import {
  dates,
  day,
  hasReading,
  length,
  nextDay,
  noShow,
  notTagged,
  notice,
  clinicRule,
  therapist,
  time,
  unclear,
} from '@/lib/rules/checks';
import type { Check } from '@/lib/rules/checks';

export * from '@/lib/rules/checks';

export const CHECKS: readonly Check[] = [
  noShow,
  notTagged,
  hasReading,
  therapist,
  clinicRule,
  length,
  day,
  time,
  notice,
  nextDay,
  dates,
  unclear,
];
