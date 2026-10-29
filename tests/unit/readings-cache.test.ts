import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WaitlistLine } from '@/lib/types';
import { readingKey } from '@/lib/readings/hash';
import { FileReadingCache, MemoryReadingCache } from '@/lib/readings/cache';
import type { ReadingCacheEntry } from '@/lib/readings/cache';
import { defaultReading } from '@/lib/readings/schema';

function line(id: string, date: string, notes: string, name = 'Ann Lee', phone = '506-555-0001'): WaitlistLine {
  return { id, n: Number(id.slice(1)), added: '', date, name, phone, phoneDigits: phone.replace(/\D/g, ''), notes };
}

const lines = [line('W01', '2026-09-01', 'any - 60 - AM'), line('W05', '2026-10-01', 'again - not Fri')];

describe('readingKey', () => {
  it('is a sha256 hex string and stable across calls', () => {
    const k = readingKey(lines, 2026);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(readingKey(structuredClone(lines), 2026)).toBe(k);
  });

  it('is a known value (stable across runs and machines)', () => {
    // Recomputed independently so a change to the hashing scheme is noticed.
    const expected = createHash('sha256')
      .update(JSON.stringify(['reading-v1', 2026, [['W01', '2026-09-01', 'any']]]))
      .digest('hex');
    expect(readingKey([line('W01', '2026-09-01', 'any')], 2026)).toBe(expected);
  });

  it('changes when notes, a date, a line id, the order or the run year change', () => {
    const k = readingKey(lines, 2026);
    expect(readingKey([lines[0]!, { ...lines[1]!, notes: 'again - not Thurs' }], 2026)).not.toBe(k);
    expect(readingKey([lines[0]!, { ...lines[1]!, date: '2026-10-02' }], 2026)).not.toBe(k);
    expect(readingKey([lines[0]!, { ...lines[1]!, id: 'W06' }], 2026)).not.toBe(k);
    expect(readingKey([lines[1]!, lines[0]!], 2026)).not.toBe(k);
    expect(readingKey(lines, 2027)).not.toBe(k);
  });

  it('ignores names and phones (they are never sent)', () => {
    const other = lines.map((l) => ({ ...l, name: 'Someone Else', phone: '506-555-9999', phoneDigits: '5065559999' }));
    expect(readingKey(other, 2026)).toBe(readingKey(lines, 2026));
  });
});

const entry = (by: 'claude' | 'saved', note = ''): ReadingCacheEntry => ({
  reading: defaultReading(),
  readAt: '2026-10-29T12:00:00.000Z',
  by,
  problems: note ? [note] : [],
});

describe('MemoryReadingCache', () => {
  it('round-trips entries and lists them with sorted keys', async () => {
    const c = new MemoryReadingCache();
    expect(await c.get('b')).toBeUndefined();
    await c.set('b', entry('claude'));
    await c.set('a', entry('saved', 'x'));
    expect(await c.get('b')).toEqual(entry('claude'));
    expect(Object.keys(await c.all())).toEqual(['a', 'b']);
  });

  it('returns copies, so callers cannot change what is stored', async () => {
    const c = new MemoryReadingCache();
    await c.set('a', entry('claude'));
    const got = (await c.get('a'))!;
    got.problems.push('changed');
    expect((await c.get('a'))!.problems).toEqual([]);
  });
});

describe('FileReadingCache', () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'readings-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('starts empty when the file does not exist', async () => {
    const c = new FileReadingCache(path.join(tmp(), 'readings.json'));
    expect(await c.all()).toEqual({});
    expect(await c.get('x')).toBeUndefined();
  });

  it('writes a JSON file with sorted keys that a new instance reads back', async () => {
    const dir = tmp();
    const file = path.join(dir, 'sub', 'readings.json');
    const c = new FileReadingCache(file);
    await c.set('zz', entry('claude'));
    await c.set('aa', entry('saved', 'one problem'));
    await Promise.all([c.set('mm', entry('claude')), c.set('bb', entry('claude'))]);

    const text = fs.readFileSync(file, 'utf8');
    expect(Object.keys(JSON.parse(text))).toEqual(['aa', 'bb', 'mm', 'zz']);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['readings.json']); // no temp files left behind

    const again = new FileReadingCache(file);
    expect(await again.get('aa')).toEqual(entry('saved', 'one problem'));
    expect(Object.keys(await again.all())).toEqual(['aa', 'bb', 'mm', 'zz']);
  });
});
