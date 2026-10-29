// `npm run check:claude` (feature 7): is the Anthropic key in .env.local working for the note reader?
//   No key   -> says the app uses the saved readings only, and how to add a key. Nothing is sent anywhere.
//   With key -> ONE small reading call through the app's own reader (readWithClaude, same request as an import) on
//               one made-up line ("any - 60 - not Mon"; no client data), checks the answer with validateReading,
//               and prints OK with the model, the token usage and the cost, or the exact failure and what to do.
// One call costs about one to three cents (a ~4,000-token request at $4 per million input tokens plus a few hundred
// output tokens at $20 per million; the exact cost is printed). The key is never printed.
import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { CLINIC_TIME_ZONE } from '@/lib/clinic';
import { todayIso } from '@/lib/format';
import { READING_MODEL, readWithClaude } from '@/lib/readings/claude';
import { validateReading } from '@/lib/readings/validate';
import { redact } from '@/lib/supabase/check';
import type { WaitlistLine } from '@/lib/types';

/** The made-up line the check reads. Only its id, date and notes are sent (as for every reading). */
export const CHECK_NOTES = 'any - 60 - not Mon';

export function checkLine(now: Date = new Date()): WaitlistLine {
  return {
    id: 'W01',
    n: 1,
    added: 'today',
    date: todayIso(now, CLINIC_TIME_ZONE),
    name: 'Check Line',
    phone: '',
    phoneDigits: null,
    notes: CHECK_NOTES,
  };
}

/** claude-opus-5-5 list prices, US$ per million tokens (October 2026). Cache writes 1.25x input, reads 0.1x. */
export const PRICE_PER_MILLION = { input: 4, output: 20 } as const;

/** Estimated US$ cost of one call from its usage. */
export function callCost(usage: BetaUsage): number {
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1;
  return (input * PRICE_PER_MILLION.input + (usage.output_tokens ?? 0) * PRICE_PER_MILLION.output) / 1_000_000;
}

const n = (v: number | null | undefined) => (v ?? 0).toLocaleString('en-US');

export function usageText(usage: BetaUsage): string {
  const cached =
    (usage.cache_read_input_tokens ?? 0) || (usage.cache_creation_input_tokens ?? 0)
      ? ` (+ ${n(usage.cache_creation_input_tokens)} written to / ${n(usage.cache_read_input_tokens)} read from the prompt cache)`
      : '';
  return `${n(usage.input_tokens)} input${cached} + ${n(usage.output_tokens)} output tokens`;
}

export const HOW_TO_ADD_KEY = `To let Claude read new notes:
  1. Sign in at https://console.anthropic.com and create an API key (Settings > API keys).
  2. Set a monthly spend limit (Settings > Limits), for example $10.
  3. Open .env.local in this folder yourself (copy .env.example if it is not there) and paste the key after
       ANTHROPIC_API_KEY=
     Never paste the key into a chat, an email or a file anyone else sees.
  4. Run npm run check:claude again. Then restart npm run dev so the app picks it up.`;

/** Plain-words advice for an API error. */
function advice(err: unknown): string {
  if (err instanceof APIConnectionError) {
    return 'Could not reach api.anthropic.com. Check the internet connection (or a firewall / proxy), then try again.';
  }
  if (err instanceof APIError) {
    const message = String(err.message ?? '');
    switch (err.status) {
      case 401:
        return 'The key was refused. Copy it again from console.anthropic.com (Settings > API keys) into .env.local, with no spaces or quotes around it.';
      case 403:
        return `This key is not allowed to use ${READING_MODEL}. Check the workspace's model access in the Console.`;
      case 404:
        return `The model ${READING_MODEL} was not found for this key. Check the workspace's model access in the Console.`;
      case 429:
        return 'Rate limit or spend limit reached. Wait a minute, or raise the limit in the Console (Settings > Limits).';
      case 400:
        if (/credit balance|billing|purchase credits/i.test(message)) {
          return 'The account has no credit left. Add credits in the Console (Settings > Billing).';
        }
        return 'Anthropic refused the request as written. The exact error is above; the app may need an update for this API version.';
      default:
        if (typeof err.status === 'number' && err.status >= 500) {
          return 'Anthropic is busy or having trouble right now. Try again in a few minutes.';
        }
    }
  }
  return 'See the exact error above.';
}

function errorText(err: unknown): string {
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? ` (HTTP ${err.status}${err.type ? `, ${err.type}` : ''})` : '';
    const id = err.requestID ? ` [request id ${err.requestID}]` : '';
    // The SDK's error classes keep name "Error"; the class name says more (AuthenticationError, RateLimitError...).
    const kind = err.constructor?.name && err.constructor.name !== 'Error' ? err.constructor.name : err.name;
    return `${kind}${status}: ${err.message}${id}`;
  }
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export interface CheckClaudeOptions {
  apiKey: string | undefined;
  /** Builds the client. Tests pass a mock; the default is the real SDK client. */
  makeClient?: (apiKey: string) => Anthropic;
  now?: Date;
}

export interface CheckClaudeResult {
  /** true when there is no key (saved readings only) or the call worked. */
  ok: boolean;
  /** Whether a call was made. */
  called: boolean;
  lines: string[];
}

export async function checkClaude(opts: CheckClaudeOptions): Promise<CheckClaudeResult> {
  const apiKey = (opts.apiKey ?? '').trim();
  if (!apiKey) {
    return {
      ok: true,
      called: false,
      lines: [
        'ANTHROPIC_API_KEY is not set.',
        'The app uses the saved readings only: the sample waitlist works offline, and anyone without a saved reading',
        'shows as "not read" in Waitlist (admin) and is never offered until Claude reads their notes.',
        '',
        HOW_TO_ADD_KEY,
      ],
    };
  }

  const lines: string[] = [];
  if (!apiKey.startsWith('sk-ant-')) lines.push('Note: Anthropic API keys start with "sk-ant-". Check the value in .env.local.');
  lines.push(`Sending one small test reading to ${READING_MODEL} (the made-up line "${CHECK_NOTES}"; no client data)...`);

  const real = (opts.makeClient ?? ((key: string) => new Anthropic({ apiKey: key, maxRetries: 1 })))(apiKey);
  // The reader turns API errors into a short reason; keep the exact error for this check.
  // Filled by the callbacks below (an object, so TypeScript does not narrow them to null).
  const seen: { apiError: unknown; usage: BetaUsage | null } = { apiError: null, usage: null };
  const client = {
    beta: {
      messages: {
        create: async (request: Parameters<Anthropic['beta']['messages']['create']>[0]) => {
          try {
            return await real.beta.messages.create(request);
          } catch (err) {
            seen.apiError = err;
            throw err;
          }
        },
      },
    },
  } as unknown as Anthropic;

  const line = checkLine(opts.now);
  const result = await readWithClaude([line], {
    client,
    runYear: Number(line.date.slice(0, 4)),
    log: (entry) => {
      seen.usage = entry.usage;
    },
  });
  const secrets = [apiKey];
  const done = (ok: boolean): CheckClaudeResult => ({ ok, called: true, lines: lines.map((l) => redact(l, secrets)) });

  if (!result.ok) {
    lines.push(`PROBLEM: ${result.problem}`);
    if (seen.apiError) {
      lines.push(`Exact error: ${errorText(seen.apiError)}`);
      lines.push(advice(seen.apiError));
    }
    if (seen.usage) lines.push(`Usage: ${usageText(seen.usage)}.`);
    return done(false);
  }

  const { reading, problems } = validateReading(result.raw, [line]);
  if (problems.length > 0) {
    lines.push(`PROBLEM: Claude answered (model ${result.model}), but the answer did not pass the app's checks:`);
    for (const p of problems) lines.push(`  - ${p}`);
    lines.push('Imports would mark these people "unclear" and not offer them. Try again; if it repeats, the prompt or schema needs a look.');
    return done(false);
  }

  // The test line has a known meaning; a different reading means Claude is not reading notes the way the rules need.
  const expected: string[] = [];
  if (reading.therapistsAllowed.value !== null || reading.therapistsExcluded.value.length > 0) expected.push('any therapist');
  if (!reading.lengths.value.minutes.includes(60)) expected.push('60 minutes');
  if (!reading.daysExcluded.value.includes('Mon')) expected.push('not Mondays');
  if (expected.length > 0) {
    lines.push(`PROBLEM: Claude answered (model ${result.model}) and the answer passed the checks, but it did not read: ${expected.join(', ')}.`);
    return done(false);
  }

  lines.push(`OK: Claude read the test line correctly (any therapist, 60 minutes, not Mondays) and the answer passed the app's checks.`);
  lines.push(`Model: ${result.model}`);
  if (seen.usage) {
    lines.push(`Usage: ${usageText(seen.usage)}.`);
    lines.push(`Cost of this check: about US$${callCost(seen.usage).toFixed(3)} (at ${READING_MODEL} list prices, $${PRICE_PER_MILLION.input} / $${PRICE_PER_MILLION.output} per million tokens).`);
  }
  lines.push('Claude is connected. Restart npm run dev if it is running, then import the waitlist again in Waitlist (admin).');
  return done(true);
}
