import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { parseWaitlist } from '@/lib/csv';
import { groupLines } from '@/lib/import';
import type { Reading, WaitlistLine } from '@/lib/types';
import { MemoryReadingCache } from '@/lib/readings/cache';
import { buildReadingRequest, readWithClaude } from '@/lib/readings/claude';
import type { ReadingCallLog } from '@/lib/readings/claude';
import { readingKey } from '@/lib/readings/hash';
import { buildUserMessage, SYSTEM_PROMPT } from '@/lib/readings/prompt';
import { makeGetReading, readAll } from '@/lib/readings/reader';
import { defaultReading } from '@/lib/readings/schema';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const lines = parseWaitlist(fs.readFileSync(SAMPLE + 'waitlist-2026-10-21.csv', 'utf8'), 2026);
const groups = groupLines(lines);

function message(over: Partial<BetaMessage> & { text?: string }): BetaMessage {
  const { text, ...rest } = over;
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: text === undefined ? [] : [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...rest,
  } as unknown as BetaMessage;
}

/** A Claude reply: the default reading, plus a quoted length from the newest line when it has "60". */
function replyFor(params: MessageCreateParamsNonStreaming): BetaMessage {
  const ids = [...String(params.messages[0]!.content).matchAll(/"lineId": "(W\d+)"/g)].map((m) => m[1]!);
  const group = groups.find((g) => g.map((l) => l.id).join() === ids.join())!;
  const newest = group[group.length - 1]!;
  const r: Reading = defaultReading();
  if (/\b60\b/.test(newest.notes)) r.lengths = { value: { minutes: [60], only: false }, source: [{ lineId: newest.id, text: '60' }] };
  return message({ text: JSON.stringify(r) });
}

function mockClient(respond: (p: MessageCreateParamsNonStreaming) => BetaMessage | Promise<BetaMessage>) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const create = vi.fn(async (p: MessageCreateParamsNonStreaming) => {
    calls.push(p);
    return respond(p);
  });
  const client = { beta: { messages: { create } } } as unknown as Anthropic;
  return { client, calls, create };
}

describe('the request sent to Claude', () => {
  const group = groups.find((g) => g.some((l) => l.id === 'W42'))!;
  const req = buildReadingRequest(group, 2026);

  it('uses claude-opus-5-5 with effort low, structured outputs, fallbacks, and no thinking field', () => {
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.output_config?.effort).toBe('low');
    expect(req.output_config?.format?.type).toBe('json_schema');
    expect(req.fallbacks).toBe('default');
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect('thinking' in req).toBe(false);
    expect(req.stream).toBeUndefined();
    expect(req.max_tokens).toBeGreaterThanOrEqual(4000);
  });

  it('sends only line ids, line dates and notes', () => {
    expect(JSON.parse(buildUserMessage(group, 2026).split('\n').slice(2).join('\n'))).toEqual(
      group.map((l) => ({ lineId: l.id, date: l.date, notes: l.notes })),
    );
  });
});

describe('readAll with a mocked client', () => {
  it('a miss calls the client once per person, then a second run is all cached with zero calls', async () => {
    const cache = new MemoryReadingCache();
    const { client, calls, create } = mockClient(replyFor);
    const logs: ReadingCallLog[] = [];
    const first = await readAll(groups, { cache, client, runYear: 2026, log: (e) => logs.push(e), now: () => new Date('2026-10-29T10:00:00Z') });

    expect(create).toHaveBeenCalledTimes(groups.length);
    expect(first.size).toBe(45);
    expect([...first.keys()]).toEqual(groups.map((g) => g[g.length - 1]!.id));
    for (const res of first.values()) {
      expect(res.status).toBe('claude');
      expect(res.problems).toEqual([]);
      expect(res.reading).not.toBeNull();
    }
    const stored = await cache.all();
    expect(Object.keys(stored)).toHaveLength(45);
    for (const e of Object.values(stored)) expect(e).toMatchObject({ by: 'claude', readAt: '2026-10-29T10:00:00.000Z' });

    // Privacy: every request body is free of names and phone numbers; the log has ids and sizes only.
    const body = JSON.stringify(calls);
    for (const l of lines) {
      expect(body, l.id).not.toContain(l.name);
      if (l.phoneDigits) {
        expect(body, l.id).not.toContain(l.phoneDigits);
        expect(body, l.id).not.toContain(l.phone);
      }
    }
    for (const c of calls) expect(c.model).toBe('claude-opus-5-5');
    expect(logs).toHaveLength(45);
    const logText = JSON.stringify(logs);
    for (const l of lines) {
      expect(logText).not.toContain(l.name);
      if (l.notes.length > 8) expect(logText).not.toContain(l.notes);
    }
    expect(logs[0]).toMatchObject({ model: 'claude-opus-5-5', stopReason: 'end_turn', sentLineIds: groups[0]!.map((l) => l.id) });
    expect(logs[0]!.sentChars).toBeGreaterThan(0);

    const second = await readAll(groups, { cache, client, runYear: 2026 });
    expect(create).toHaveBeenCalledTimes(groups.length); // no new calls
    for (const res of second.values()) expect(res.status).toBe('cached');
    expect([...second.values()].map((r) => r.reading)).toEqual([...first.values()].map((r) => r.reading));
  });

  it('with client null, misses are "not read" with no reading, and hits still come from the cache', async () => {
    const cache = new MemoryReadingCache();
    const first = groups[0]!;
    await cache.set(readingKey(first, 2026), { reading: defaultReading(), readAt: 'x', by: 'saved', problems: [] });
    const res = await readAll(groups, { cache, client: null, runYear: 2026 });
    expect(res.get(first[first.length - 1]!.id)!.status).toBe('cached');
    const rest = [...res.values()].slice(1);
    expect(rest).toHaveLength(44);
    for (const r of rest) {
      expect(r.status).toBe('not read');
      expect(r.reading).toBeNull();
    }
    expect(Object.keys(await cache.all())).toHaveLength(1);
  });

  it('a refusal is "failed", not a reading, and is not cached', async () => {
    const cache = new MemoryReadingCache();
    const { client } = mockClient(() =>
      message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: null } as never }),
    );
    const two = groups.slice(0, 2);
    const res = await readAll(two, { cache, client, runYear: 2026 });
    for (const r of res.values()) {
      expect(r.status).toBe('failed');
      expect(r.reading).toBeNull();
      expect(r.problems[0]).toMatch(/refusal/);
    }
    expect(await cache.all()).toEqual({});
  });

  it('max_tokens, a thrown API error and non-JSON text are failures too', async () => {
    const g = groups[0]!;
    const run = (respond: () => BetaMessage | Promise<BetaMessage>) =>
      readWithClaude(g, { client: mockClient(respond).client, runYear: 2026 });
    expect(await run(() => message({ stop_reason: 'max_tokens', text: '{"therapists' }))).toMatchObject({ ok: false });
    expect(await run(() => Promise.reject(Object.assign(new Error('boom'), { status: 529 })))).toEqual({
      ok: false,
      problem: 'The Claude call failed: Error (HTTP 529).',
    });
    expect(await run(() => message({ text: 'not json' }))).toMatchObject({ ok: false });
    expect(await run(() => message({}))).toMatchObject({ ok: false });
  });

  it('a reply that fails validation is cached with its problems, the bad field reset and marked unclear', async () => {
    const cache = new MemoryReadingCache();
    const g = groups.find((x) => x.some((l) => l.id === 'W33'))!;
    const bad = defaultReading();
    bad.therapistsExcluded = { value: ['Dave Melanson'], source: [{ lineId: 'W33', text: 'anyone but Dave' }] }; // not the words
    const { client } = mockClient(() => message({ text: JSON.stringify(bad) }));
    const res = (await readAll([g], { cache, client, runYear: 2026 })).get('W33')!;
    expect(res.status).toBe('claude');
    expect(res.reading!.therapistsExcluded).toEqual({ value: [], source: [] });
    expect(res.reading!.unclear.some((u) => u.affects.includes('therapist'))).toBe(true);
    expect(res.problems).toHaveLength(1);
    expect((await cache.get(res.key))!.problems).toEqual(res.problems);
  });

  it('runs misses in parallel, never more than `concurrency` at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const { client } = mockClient(async (p) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return replyFor(p);
    });
    await readAll(groups.slice(0, 12), { cache: new MemoryReadingCache(), client, runYear: 2026, concurrency: 3 });
    expect(peak).toBe(3);
  });
});

describe('makeGetReading', () => {
  it('returns the reading for a known group and undefined otherwise', async () => {
    const cache = new MemoryReadingCache();
    const g = groups[0]!;
    await cache.set(readingKey(g, 2026), { reading: defaultReading(), readAt: 'x', by: 'saved', problems: [] });
    const res = await readAll(groups, { cache, client: null, runYear: 2026 });
    const get = makeGetReading(res, groups);
    expect(get(g)).toEqual(defaultReading());
    expect(get(groups[1]!)).toBeUndefined(); // not read
    const other: WaitlistLine[] = [{ ...g[0]!, id: 'W99' }];
    expect(get(other)).toBeUndefined();
  });
});

it('the system prompt names no waitlist client', () => {
  for (const l of lines) expect(SYSTEM_PROMPT).not.toContain(l.name);
});
