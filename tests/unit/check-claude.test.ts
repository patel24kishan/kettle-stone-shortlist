// npm run check:claude (src/lib/check-claude.ts, feature 7) with a mocked Anthropic client: never a real call.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { CHECK_NOTES, callCost, checkClaude } from '@/lib/check-claude';

const FAKE_KEY = 'sk-ant-test-not-a-real-key-1234567890';
const USAGE = { input_tokens: 3200, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const q = (text: string) => [{ lineId: 'W01', text }];
/** A correct reading of "any - 60 - not Mon". */
const GOOD = {
  therapistsAllowed: { value: null, source: [] },
  therapistsExcluded: { value: [], source: [] },
  lengths: { value: { minutes: [60], only: false }, source: q('60') },
  daysAllowed: { value: null, source: [] },
  daysExcluded: { value: ['Mon'], source: q('not Mon') },
  startEarliest: { value: null, source: [] },
  startLatest: { value: null, source: [] },
  endBy: { value: null, source: [] },
  noticeHours: { value: 2, source: [] },
  nextDayOnly: { value: false, source: [] },
  availableFrom: { value: null, source: [] },
  availableUntil: { value: null, source: [] },
  prenatal: { value: false, source: [] },
  gone: { value: null, source: [] },
  unclear: [],
};

function message(raw: unknown, extra: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(raw), citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: USAGE,
    ...extra,
  } as unknown as BetaMessage;
}

function mockClient(answer: (req: MessageCreateParamsNonStreaming) => Promise<BetaMessage>) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const keys: string[] = [];
  const makeClient = (key: string) => {
    keys.push(key);
    return {
      beta: {
        messages: {
          create: async (req: MessageCreateParamsNonStreaming) => {
            calls.push(req);
            return answer(req);
          },
        },
      },
    } as unknown as Anthropic;
  };
  return { calls, keys, makeClient };
}

const all = (lines: string[]) => lines.join('\n');

describe('no key', () => {
  it('says the app uses saved readings only and how to add the key; makes no call', async () => {
    const m = mockClient(async () => message(GOOD));
    for (const apiKey of [undefined, '', '   ']) {
      const res = await checkClaude({ apiKey, makeClient: m.makeClient });
      expect(res).toMatchObject({ ok: true, called: false });
      expect(all(res.lines)).toContain('saved readings only');
      expect(all(res.lines)).toContain('console.anthropic.com');
      expect(all(res.lines)).toContain('.env.local');
      expect(all(res.lines)).toMatch(/spend limit/i);
      expect(all(res.lines)).toContain('Never paste the key');
    }
    expect(m.calls).toHaveLength(0);
  });
});

describe('with a key (mocked client)', () => {
  it('one call, on the made-up line only, then OK with model, usage and cost', async () => {
    const m = mockClient(async () => message(GOOD));
    const res = await checkClaude({ apiKey: FAKE_KEY, makeClient: m.makeClient, now: new Date('2026-10-29T15:00:00Z') });
    expect(res.ok).toBe(true);
    expect(m.calls).toHaveLength(1);
    expect(m.keys).toEqual([FAKE_KEY]);
    const sent = JSON.stringify(m.calls[0]!.messages);
    expect(sent).toContain(CHECK_NOTES);
    expect(sent).not.toContain('Check Line'); // the made-up name is never sent either
    expect(m.calls[0]!.model).toBe('claude-opus-5-5');
    const text = all(res.lines);
    expect(text).toContain('OK: Claude read the test line correctly');
    expect(text).toContain('Model: claude-opus-5-5');
    expect(text).toContain('3,200 input + 400 output tokens');
    expect(text).toContain('US$0.021');
  });

  it('cost: $4 in / $20 out per million, cache writes 1.25x, reads 0.1x', () => {
    expect(callCost({ input_tokens: 1_000_000, output_tokens: 0 } as never)).toBeCloseTo(4);
    expect(callCost({ input_tokens: 0, output_tokens: 1_000_000 } as never)).toBeCloseTo(20);
    expect(callCost({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 } as never)).toBeCloseTo(5.4);
  });

  it('a wrong key: the exact error and what to do, never the key', async () => {
    const m = mockClient(async () => {
      throw APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, undefined, new Headers());
    });
    const res = await checkClaude({ apiKey: FAKE_KEY, makeClient: m.makeClient });
    expect(res.ok).toBe(false);
    const text = all(res.lines);
    expect(text).toContain('PROBLEM: The Claude call failed:');
    expect(text).toContain('Exact error: AuthenticationError (HTTP 401, authentication_error)');
    expect(text).toContain('invalid x-api-key');
    expect(text).toContain('Copy it again');
    expect(text).not.toContain(FAKE_KEY);
  });

  it('an error message that echoes the key is redacted', async () => {
    const m = mockClient(async () => {
      throw new Error(`bad key ${FAKE_KEY}`);
    });
    const res = await checkClaude({ apiKey: FAKE_KEY, makeClient: m.makeClient });
    expect(res.ok).toBe(false);
    expect(all(res.lines)).not.toContain(FAKE_KEY);
    expect(all(res.lines)).toContain('[hidden]');
  });

  it('no credit, rate limit, no internet: each gets its own advice', async () => {
    const cases: [unknown, RegExp][] = [
      [APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, undefined, new Headers()), /Add credits/],
      [APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, new Headers()), /spend limit/],
      [new APIConnectionError({ message: 'Connection error.' }), /internet connection/],
      [APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()), /busy/],
    ];
    for (const [err, advice] of cases) {
      const m = mockClient(async () => {
        throw err;
      });
      const res = await checkClaude({ apiKey: FAKE_KEY, makeClient: m.makeClient });
      expect(res.ok).toBe(false);
      expect(all(res.lines)).toMatch(advice);
    }
  });

  it('a refusal or a cut-off answer is a failure', async () => {
    for (const extra of [{ stop_reason: 'refusal' }, { stop_reason: 'max_tokens' }] as Partial<BetaMessage>[]) {
      const m = mockClient(async () => message(GOOD, extra));
      const res = await checkClaude({ apiKey: FAKE_KEY, makeClient: m.makeClient });
      expect(res.ok).toBe(false);
      expect(all(res.lines)).toContain('PROBLEM:');
      expect(all(res.lines)).toContain('Usage:');
    }
  });

  it('an answer that fails validateReading is a failure (with the problems listed)', async () => {
    const bad = { ...GOOD, daysExcluded: { value: ['Mon'], source: q('never on mondays') } };
    const m = mockClient(async () => message(bad));
    const res = await checkClaude({ apiKey: FAKE_KEY, makeClient: m.makeClient });
    expect(res.ok).toBe(false);
    expect(all(res.lines)).toContain("did not pass the app's checks");
    expect(all(res.lines)).toContain('not in that line');
  });

  it('a valid answer that reads the line wrongly is a failure', async () => {
    const wrong = { ...GOOD, daysExcluded: { value: [], source: [] } };
    const m = mockClient(async () => message(wrong));
    const res = await checkClaude({ apiKey: FAKE_KEY, makeClient: m.makeClient });
    expect(res.ok).toBe(false);
    expect(all(res.lines)).toContain('did not read: not Mondays');
  });
});

describe('the script', () => {
  it('npm run check:claude with no key: the saved-readings message, exit 0, nothing sent', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, SHORTLIST_SKIP_ENV_FILE: '1' };
    delete env.ANTHROPIC_API_KEY;
    const res = spawnSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/check-claude.ts'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('ANTHROPIC_API_KEY is not set.');
    expect(res.stdout).toContain('saved readings only');
  }, 60_000);
});
