// One Messages API call per person (build-plan section 4: "Claude reads, code picks").
// SDK usage, taken from the bundled claude-api docs and the installed @anthropic-ai/sdk 1.3.0 types:
// - client.beta.messages.create with `betas` + `fallbacks`: typescript/claude-api/README.md "Refusal Fallbacks";
//   `fallbacks: "default"` with header `server-side-fallback-2026-07-01`: shared/model-migration.md
//   "Migrating to Claude Opus 5 > New API features" and "Migrating to Claude Opus 5.5 > Safeguards".
// - Structured outputs via output_config.format from a zod schema: typescript/claude-api/tool-use.md
//   "Structured Outputs". On the beta namespace the helper is `betaZodOutputFormat`
//   (@anthropic-ai/sdk/helpers/beta/zod); passed to `.create()` it does not auto-parse, so we check
//   stop_reason first (as the docs require) and parse the text ourselves.
// - output_config.effort "low" set explicitly, no `thinking` field (thinking: disabled 400s on this model):
//   model-migration.md "Migrating to Claude Opus 5.5 > Breaking change 1" and "Choosing an effort level".
// - System prompt cached with cache_control: README.md "Manual Cache Control".
import type Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessage, BetaUsage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { WaitlistLine } from '@/lib/types';
import { WireSchema, wireToReading } from '@/lib/readings/schema';
import { SYSTEM_PROMPT, buildUserMessage } from '@/lib/readings/prompt';

export const READING_MODEL = 'claude-opus-5-5';
export const READING_EFFORT = 'low' as const;
/** Non-streaming; thinking counts toward max_tokens, and a reading is a few hundred tokens of JSON. */
export const READING_MAX_TOKENS = 16000;
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** What is logged per call. Line ids, sizes and usage only: never names, phones or note text. */
export interface ReadingCallLog {
  sentLineIds: string[];
  sentChars: number;
  model: string;
  usage: BetaUsage | null;
  stopReason: string | null;
  error?: string;
}

export interface ReadWithClaudeOptions {
  client: Anthropic;
  runYear: number;
  log?: (entry: ReadingCallLog) => void;
}

export type ClaudeReadResult =
  | { ok: true; raw: unknown; model: string }
  | { ok: false; problem: string };

/** The request for one person. Exported so tests can inspect exactly what would be sent. */
export function buildReadingRequest(lines: WaitlistLine[], runYear: number): MessageCreateParamsNonStreaming {
  return {
    model: READING_MODEL,
    max_tokens: READING_MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    // The flat wire schema: the full Reading schema compiles to a grammar the API rejects as too large.
    output_config: { effort: READING_EFFORT, format: betaZodOutputFormat(WireSchema) },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserMessage(lines, runYear) }],
  };
}

function textOf(message: BetaMessage): string | null {
  for (const block of message.content) if (block.type === 'text') return block.text;
  return null;
}

/**
 * Reads one person's lines with Claude. Returns the raw parsed JSON (not yet validated) or a failure.
 * Refusal and max_tokens are failures, never readings. API errors are returned as failures too.
 */
export async function readWithClaude(lines: WaitlistLine[], opts: ReadWithClaudeOptions): Promise<ClaudeReadResult> {
  const request = buildReadingRequest(lines, opts.runYear);
  const userText = request.messages[0]!.content as string;
  const base = { sentLineIds: lines.map((l) => l.id), sentChars: userText.length };

  let message: BetaMessage;
  try {
    message = await opts.client.beta.messages.create(request);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? ` (HTTP ${(err as { status: number }).status})` : '';
    const name = err instanceof Error ? err.name : 'Error';
    opts.log?.({ ...base, model: READING_MODEL, usage: null, stopReason: null, error: `${name}${status}` });
    return { ok: false, problem: `The Claude call failed: ${name}${status}.` };
  }

  opts.log?.({ ...base, model: message.model, usage: message.usage ?? null, stopReason: message.stop_reason });

  // Check stop_reason before reading content (model-migration.md "refusal stop reason").
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details && 'category' in message.stop_details ? message.stop_details.category : null;
    return { ok: false, problem: `Claude declined to read these lines (refusal${category ? `, ${category}` : ''}).` };
  }
  if (message.stop_reason === 'max_tokens') {
    return { ok: false, problem: 'Claude ran out of tokens before finishing the reading (max_tokens).' };
  }
  if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
    return { ok: false, problem: `Claude stopped early (${message.stop_reason ?? 'no stop reason'}).` };
  }
  const text = textOf(message);
  if (text === null) return { ok: false, problem: 'Claude returned no text.' };
  try {
    return { ok: true, raw: wireToReading(JSON.parse(text) as unknown), model: message.model };
  } catch {
    return { ok: false, problem: 'Claude returned text that is not JSON.' };
  }
}
