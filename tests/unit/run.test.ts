// Feature 4: the one pipeline (runShortlist) and the two hand-in CSVs.
// Expected behaviour: ../build-plan.md sections 1 (Friday scoring), 6 Step 4, 7; ../rules.md "Always".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRunCache } from '@/lib/cache-setup';
import { parseCsv } from '@/lib/csv';
import { csvField, dashedPhone, lineVerdictsCsv, resultsCsv, runShortlist } from '@/lib/run';
import type { RunOutput } from '@/lib/run';
import type { OpeningResult } from '@/lib/types';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const text = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');
const WAITLIST = text('waitlist-2026-10-21.csv');
const APPTS = text('appointments-2026-09-21-to-2026-10-17.csv');
const OPENINGS = text('late-openings-2026-09-21-to-2026-10-17.csv');
const KEY_ROWS = parseCsv(text('answer-key-tanya.csv'));

const sampleBytes = new Map<string, Buffer>();
for (const f of fs.readdirSync(SAMPLE)) sampleBytes.set(f, fs.readFileSync(path.join(SAMPLE, f)));

let TMP = '';
let n = 0;
const freshCache = () => openRunCache(path.join(TMP, `cache-${++n}.json`));
const run = (over: Partial<Parameters<typeof runShortlist>[0]> = {}) =>
  runShortlist({
    waitlistText: WAITLIST,
    appointmentsText: APPTS,
    openingsText: OPENINGS,
    runDate: '2026-10-21',
    cache: freshCache(),
    client: null,
    ...over,
  });

let BASE: RunOutput;
beforeAll(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-run-'));
  BASE = await run();
});
afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
  for (const [f, bytes] of sampleBytes) expect(fs.readFileSync(path.join(SAMPLE, f)).equals(bytes), f).toBe(true);
});

describe('runShortlist on the sample', () => {
  it('summary: 44 openings, 34 with people, 10 nobody, 8 no-shows, 30 active, nothing unread', () => {
    expect(BASE.summary).toEqual({
      openings: 44,
      withPeople: 34,
      nobody: 10,
      noShows: 8,
      linesRead: 60,
      peopleActive: 30,
      stale: 20,
      duplicates: 10,
      notRead: [],
      failed: [],
    });
    expect(BASE.runDate).toBe('2026-10-21');
    expect(BASE.lines).toHaveLength(60);
    expect(BASE.people).toHaveLength(45);
    expect([...BASE.reads.values()].every((r) => r.status === 'cached')).toBe(true);
    expect(BASE.results).toHaveLength(44);
  });

  it('resultsCsv: header, O30 has one name, O31 is none, 44 rows, LF endings, trailing newline', () => {
    const csv = resultsCsv(BASE.results);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('opening_id,shortlist');
    expect(lines).toContain('O30,W46 Shawn Duguay (506-555-0140)');
    expect(lines).toContain('O31,none');
    expect(lines).toHaveLength(46); // header + 44 rows + the empty piece after the final newline
    expect(lines.at(-1)).toBe('');
    expect(csv).not.toContain('\r');
  });

  it('Friday rule 44/44: every name shown is on the key list for that opening, nobody = nobody', () => {
    const key = new Map(
      KEY_ROWS.filter((r) => r.type === 'opening').map((r) => [
        r.id!,
        r.answer === 'none' ? [] : r.answer!.split('; ').map((s) => s.split(' ')[0]!),
      ]),
    );
    expect(key.size).toBe(44);
    const rows = parseCsv(resultsCsv(BASE.results));
    expect(rows).toHaveLength(44);
    let ok = 0;
    for (const row of rows) {
      const ids = row.shortlist === 'none' ? [] : row.shortlist!.split('; ').map((s) => s.split(' ')[0]!);
      const k = key.get(row.opening_id!)!;
      const good = ids.length ? ids.length <= 3 && ids.every((id) => k.includes(id)) : k.length === 0;
      if (good) ok++;
    }
    expect(ok).toBe(44);
  });

  it('lineVerdictsCsv: 60 rows that match the key verdicts', () => {
    const csv = lineVerdictsCsv(BASE.lines, BASE.verdicts, BASE.reasons);
    expect(csv.endsWith('\n')).toBe(true);
    expect(csv).not.toContain('\r');
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(60);
    expect(Object.keys(rows[0]!)).toEqual(['line', 'verdict', 'reason']);
    expect(rows.map((r) => r.line)).toEqual(Array.from({ length: 60 }, (_, i) => `W${String(i + 1).padStart(2, '0')}`));
    const keyLines = KEY_ROWS.filter((r) => r.type === 'waitlist line');
    expect(keyLines).toHaveLength(60);
    for (const k of keyLines) {
      const mine = rows.find((r) => r.line === k.id)!;
      expect(mine.verdict, k.id).toBe(k.answer);
    }
  });

  it('outputs hold no health words', () => {
    const all = resultsCsv(BASE.results) + lineVerdictsCsv(BASE.lines, BASE.verdicts, BASE.reasons);
    expect(all).not.toMatch(/pregnan|surgery|post-op|\bMVA\b|sciatica|cancer|fibro|concussion|migraine|TMJ/i);
  });

  it('a Booked mark is honoured; none is the default', async () => {
    const withBooked = await run({
      booked: [
        {
          personPhoneDigits: '5065550140',
          personName: 'Shawn Duguay',
          lineId: 'W46',
          openingId: 'O30',
          at: '2026-10-20T10:00:00.000Z',
          by: 'local',
        },
      ],
    });
    expect(resultsCsv(withBooked.results)).not.toContain('Shawn Duguay');
    expect(resultsCsv(BASE.results)).toContain('Shawn Duguay');
  });

  it('a new line with no saved reading and no Claude is listed as not read and never offered', async () => {
    const out = await run({ waitlistText: `${WAITLIST}61,10/20,Test Person,506-555-0199,any - 60\r\n` });
    expect(out.summary.notRead).toEqual(['W61']);
    expect(out.summary.failed).toEqual([]);
    expect(out.summary.linesRead).toBe(61);
    expect(resultsCsv(out.results)).not.toContain('Test Person');
    expect(resultsCsv(out.results)).toBe(resultsCsv(BASE.results));
  });
});

describe('column errors', () => {
  it('lists every problem in one error', async () => {
    const waitlistText = WAITLIST.replace('notes', 'comments');
    const openingsText = OPENINGS.replace('hours_notice,', '').replace('kind,', '');
    const err = await run({ waitlistText, openingsText }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('waitlist');
    expect(err!.message).toContain('notes');
    expect(err!.message).toContain('late openings');
    expect(err!.message).toContain('kind');
    expect(err!.message).toContain('hours_notice');
    expect(err!.message).not.toContain('appointments');
  });

  it('a single bad file names only that file', async () => {
    await expect(run({ appointmentsText: 'a,b\n1,2\n' })).rejects.toThrow(/appointments file.*missing column/);
  });
});

describe('CSV helpers', () => {
  it('quotes a value with a comma, a quote or a line break', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('Doe, Jane')).toBe('"Doe, Jane"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
  });

  it('resultsCsv quotes a shortlist whose name has a comma and round-trips', () => {
    const results: OpeningResult[] = [
      {
        openingId: 'O99',
        suggestions: [
          { lineId: 'W07', name: 'Smith, Jo', phoneDisplay: '(506) 555-0101' },
          { lineId: 'W08', name: 'Ann Lee', phoneDisplay: '(506) 555-0102' },
        ],
        nobodyReason: null,
        joseeNote: false,
        trace: [],
      },
      { openingId: 'O98', suggestions: [], nobodyReason: 'x', joseeNote: false, trace: [] },
    ];
    const csv = resultsCsv(results);
    expect(csv).toBe('opening_id,shortlist\nO99,"W07 Smith, Jo (506-555-0101); W08 Ann Lee (506-555-0102)"\nO98,none\n');
    expect(parseCsv(csv)).toEqual([
      { opening_id: 'O99', shortlist: 'W07 Smith, Jo (506-555-0101); W08 Ann Lee (506-555-0102)' },
      { opening_id: 'O98', shortlist: 'none' },
    ]);
  });

  it('lineVerdictsCsv quotes a reason with a comma', () => {
    const lines = BASE.lines.slice(0, 1);
    const csv = lineVerdictsCsv(lines, { W01: 'stale' }, { W01: 'Moved, number not in service.' });
    expect(csv).toBe('line,verdict,reason\nW01,stale,"Moved, number not in service."\n');
  });

  it('dashedPhone', () => {
    expect(dashedPhone('(506) 555-0140')).toBe('506-555-0140');
    expect(dashedPhone('5065550140')).toBe('506-555-0140');
    expect(dashedPhone('odd')).toBe('odd');
  });
});

describe('openRunCache', () => {
  it('creates the file seeded with every sample reading, and leaves an existing file alone', async () => {
    const p = path.join(TMP, 'seeded', 'cache.json');
    const cache = openRunCache(p);
    const seeded = await cache.all();
    expect(Object.keys(seeded)).toHaveLength(45);
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual(JSON.parse(text('readings.json')));
    fs.writeFileSync(p, '{}\n', 'utf8');
    expect(await openRunCache(p).all()).toEqual({});
  });

  it('uses seedFrom, and an absent seed gives an empty cache', async () => {
    const seed = path.join(TMP, 'my-seed.json');
    fs.writeFileSync(seed, JSON.stringify({ k1: { reading: {}, readAt: 'x', by: 'saved', problems: [] } }), 'utf8');
    expect(Object.keys(await openRunCache(path.join(TMP, 'c-seed.json'), { seedFrom: seed }).all())).toEqual(['k1']);
    expect(await openRunCache(path.join(TMP, 'c-none.json'), { seedFrom: path.join(TMP, 'nope.json') }).all()).toEqual({});
  });

  it('never opens a cache inside data/sample', () => {
    expect(() => openRunCache(path.join(SAMPLE, 'readings.json'))).toThrow(/sample/);
    expect(() => openRunCache(path.join(SAMPLE, 'new-cache.json'))).toThrow(/sample/);
  });
});
