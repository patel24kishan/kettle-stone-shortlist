// The pieces npm run check:done is built from (src/lib/done-checks.ts, feature 7). The command itself spawns the
// whole test suite, so it is not run from here; scripts/check-done.ts only wires these pieces to real runs.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOpenings } from '@/lib/csv';
import {
  HEALTH_SCAN_WORDS,
  MIN_NOTE_LENGTH,
  README_MUST_MENTION,
  REHEARSAL_EXTRA_LINES,
  differingOpenings,
  findFullNotes,
  findHealthWords,
  formatItem,
  formatSummary,
  noShowIds,
  notNobody,
  readmeMissing,
  rehearsalOpeningsCsv,
  rehearsalWaitlist,
  scanForHealthDetail,
  shortlistIds,
  waitlistNotes,
} from '@/lib/done-checks';

const SAMPLE = fileURLToPath(new URL('../../data/sample/', import.meta.url));
const sample = (f: string) => fs.readFileSync(SAMPLE + f, 'utf8');

const RESULTS = [
  'opening_id,shortlist',
  'O01,W39 Joël Bertin (506-555-0133); W42 Amanda Bourgeois (506-555-0136)',
  'O02,none',
  'O03,W12 Lynn Savoie (506-555-0112)',
  '',
].join('\n');

describe('health scan', () => {
  it('flags each planted word, whole words, any case, plurals too', () => {
    for (const w of HEALTH_SCAN_WORDS) {
      expect(findHealthWords(`W12,active,Booked after ${w.toUpperCase()} check`), w).toEqual([w.toLowerCase()]);
    }
    expect(findHealthWords('two migraines and post-op care')).toEqual(['migraine', 'post-op']);
  });

  it('does not flag parts of other words', () => {
    expect(findHealthWords('Mvamba, tmjx, surgeryroom, prefibro, cancerous')).toEqual([]);
  });

  it('passes the clean sample outputs and flags a planted word in one of them', () => {
    const notes = waitlistNotes(sample('waitlist-2026-10-21.csv'));
    const clean = [
      { name: 'results.csv', text: RESULTS },
      { name: 'line_verdicts.csv', text: 'line,verdict,reason\nW01,stale,Old line (Jul 6).\n' },
      { name: 'run.json', text: '{"runDate":"2026-10-21"}\n' },
    ];
    expect(scanForHealthDetail(clean, notes)).toEqual({ files: 3, problems: [] });
    const planted = [...clean, { name: 'bad.csv', text: 'W05,active,Cancer survivor.' }];
    expect(scanForHealthDetail(planted, notes).problems).toEqual(['bad.csv: cancer']);
  });

  it('flags a full waitlist note (also CSV-quoted) without quoting it', () => {
    const notes = waitlistNotes(sample('waitlist-2026-10-21.csv'));
    const long = notes.find((n) => n.length > 20 && n.includes(',') && findHealthWords(n).length === 0)!;
    const csvQuoted = `W01,active,"${long.replace(/"/g, '""')}"`;
    expect(findFullNotes(csvQuoted, notes)).toContain(long);
    const res = scanForHealthDetail([{ name: 'leak.csv', text: csvQuoted.toUpperCase() }], notes);
    expect(res.problems).toHaveLength(1);
    expect(res.problems[0]).toMatch(/^leak\.csv: \d+ full waitlist notes?$/);
    expect(res.problems[0]).not.toContain(long);
  });

  it('skips notes too short to tell apart from ordinary text', () => {
    expect(findFullNotes('any day, any time', ['any', '60'])).toEqual([]);
    expect(MIN_NOTE_LENGTH).toBeGreaterThan(3);
  });
});

describe('results.csv helpers', () => {
  it('reads line ids per opening, [] for none', () => {
    expect([...shortlistIds(RESULTS)]).toEqual([
      ['O01', ['W39', 'W42']],
      ['O02', []],
      ['O03', ['W12']],
    ]);
  });

  it('nobody check: missing and non-empty openings are reported', () => {
    expect(notNobody(RESULTS, ['O02'])).toEqual([]);
    expect(notNobody(RESULTS, ['O01', 'O02', 'O99'])).toEqual(['O01', 'O99']);
  });

  it('finds the 8 no-shows of the sample openings', () => {
    const ids = noShowIds(sample('late-openings-2026-09-21-to-2026-10-17.csv'));
    expect(ids).toHaveLength(8);
    expect(ids).toContain('O02');
  });

  it('compares the names shown per opening (screen vs CLI)', () => {
    expect(differingOpenings(RESULTS, RESULTS)).toEqual([]);
    const other = RESULTS.replace('O03,W12 Lynn Savoie (506-555-0112)', 'O03,none');
    expect(differingOpenings(RESULTS, other)).toEqual(['O03']);
    expect(differingOpenings(RESULTS, 'opening_id,shortlist\nO01,none\n')).toEqual(['O01', 'O02', 'O03']);
  });
});

describe('README check', () => {
  it('names what is missing', () => {
    expect(readmeMissing(README_MUST_MENTION.join('\n'))).toEqual([]);
    expect(readmeMissing('Run npm install, then npm run dev.')).toEqual([
      'npm run shortlist -- run',
      'npm run shortlist -- score',
      'npm run check:done',
      'npm test',
    ]);
  });

  it('the project README passes', () => {
    const readme = fileURLToPath(new URL('../../README.md', import.meta.url));
    expect(fs.existsSync(readme)).toBe(true);
    expect(readmeMissing(fs.readFileSync(readme, 'utf8'))).toEqual([]);
  });
});

describe('the rehearsal files', () => {
  it('the waitlist is the sample plus two lines, sample bytes untouched', () => {
    const base = sample('waitlist-2026-10-21.csv');
    const text = rehearsalWaitlist(base);
    expect(text.startsWith(base)).toBe(true);
    expect(waitlistNotes(text)).toHaveLength(waitlistNotes(base).length + REHEARSAL_EXTRA_LINES.length);
  });

  it('ten openings with the real columns, two no-shows', () => {
    const csv = rehearsalOpeningsCsv();
    expect(parseOpenings(csv)).toHaveLength(10);
    expect(noShowIds(csv)).toEqual(['O02', 'O08']);
  });
});

describe('printing', () => {
  it('one ✅ / ❌ line per item with its evidence, then a summary', () => {
    expect(formatItem({ ok: true, title: 'A', evidence: ['60/60', 'more'] })).toBe('✅ A — 60/60\n     more');
    expect(formatItem({ ok: false, title: 'B', evidence: [] })).toBe('❌ B');
    expect(formatSummary([{ ok: true, title: 'A', evidence: [] }])).toBe('All 1 checks passed.');
    expect(formatSummary([{ ok: true, title: 'A', evidence: [] }, { ok: false, title: 'B', evidence: [] }])).toBe('1 of 2 checks failed: B.');
  });
});
