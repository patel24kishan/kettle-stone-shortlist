// Feature 5: the scorer. Expected behaviour: ../build-plan.md section 1 (how Friday scores), section 6 Step 5 and
// section 7. An opening matches when every name shown is on the key's list (or nobody vs "none"); order does not
// count; names are compared by line id only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRunCache } from '@/lib/cache-setup';
import { lineVerdictsCsv, resultsCsv, runShortlist } from '@/lib/run';
import {
  formatReport,
  parseAnswerKey,
  parseLineVerdictsCsv,
  parseResultsCsv,
  scoreLines,
  scoreOpenings,
} from '@/lib/score';

const SAMPLE = path.join(fileURLToPath(new URL('../../', import.meta.url)), 'data', 'sample');
const sampleText = (f: string) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');

let TMP = '';
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-score-'));
});
afterAll(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

const KEY_HEADER = 'id,type,answer,marked_by,note';
const keyOf = (...rows: string[]) => parseAnswerKey([KEY_HEADER, ...rows].join('\n'));
const opening = (id: string, answer: string) => `${id},opening,${answer},Tanya,"note, with comma"`;
const line = (id: string, answer: string) => `${id},waitlist line,${answer},Tanya,note`;
const results = (...rows: [string, string[]][]) => new Map(rows);

describe('the sample, end to end', () => {
  it('scores 44/44 (Friday), 44/44 (first 3) and 60/60 lines', async () => {
    const out = await runShortlist({
      waitlistText: sampleText('waitlist-2026-10-21.csv'),
      appointmentsText: sampleText('appointments-2026-09-21-to-2026-10-17.csv'),
      openingsText: sampleText('late-openings-2026-09-21-to-2026-10-17.csv'),
      runDate: '2026-10-21',
      cache: openRunCache(path.join(TMP, 'cache.json')),
      client: null,
    });
    const key = parseAnswerKey(sampleText('answer-key-tanya.csv'));
    const o = scoreOpenings(parseResultsCsv(resultsCsv(out.results)), key);
    const l = scoreLines(parseLineVerdictsCsv(lineVerdictsCsv(out.lines, out.verdicts, out.reasons)), key);
    expect(o.totals).toEqual({ openings: 44, fridayMatches: 44, first3Matches: 44 });
    expect(o.notInKey).toEqual([]);
    expect(l.totals).toEqual({ lines: 60, matches: 60 });
    const report = formatReport(o, l);
    expect(report).toContain("Openings: 44/44 match (Friday rule) · 44/44 equal Tanya's first 3");
    expect(report).toContain('Lines: 60/60');
    expect(report).not.toContain('MISMATCH');
  });
});

describe('scoreOpenings', () => {
  const key = keyOf(opening('O1', 'W10 Ann; W12 Bob; W15 Cy; W20 Di; W30 Ed'), opening('O2', 'none'), opening('O3', 'W05 Al; W06 Bo'));

  it('a name that is not on the list is a mismatch and says which', () => {
    const s = scoreOpenings(results(['O1', ['W10', 'W99']], ['O2', []], ['O3', ['W05']]), key).scores[0]!;
    expect(s.fridayMatch).toBe(false);
    expect(s.first3Match).toBe(false);
    expect(s.problem).toBe("W99 is not on Tanya's list");
  });

  it('names where Tanya says nobody, and nobody where Tanya has names', () => {
    const r = scoreOpenings(results(['O1', []], ['O2', ['W10', 'W12']], ['O3', ['W05', 'W06']]), key);
    expect(r.scores[0]!.problem).toBe('we showed nobody but Tanya has 5');
    expect(r.scores[1]!.problem).toBe('we showed 2 names but Tanya says nobody');
    expect(r.scores[2]!.fridayMatch).toBe(true);
    expect(r.totals).toEqual({ openings: 3, fridayMatches: 1, first3Matches: 1 });
  });

  it('nobody vs "none" is a match in both checks', () => {
    const s = scoreOpenings(results(['O1', ['W10']], ['O2', []], ['O3', ['W05']]), key).scores[1]!;
    expect(s.fridayMatch).toBe(true);
    expect(s.first3Match).toBe(true);
    expect(s.problem).toBeNull();
  });

  it('2 correct names out of a 5-person list: Friday match, not the first 3', () => {
    const s = scoreOpenings(results(['O1', ['W10', 'W12']], ['O2', []], ['O3', []]), key).scores[0]!;
    expect(s.fridayMatch).toBe(true);
    expect(s.first3Match).toBe(false);
    expect(s.problem).toBeNull();
  });

  it('order does not matter for the Friday rule, but does for the first 3', () => {
    const s = scoreOpenings(results(['O1', ['W15', 'W10', 'W12']], ['O2', []], ['O3', []]), key).scores[0]!;
    expect(s.fridayMatch).toBe(true);
    expect(s.first3Match).toBe(false);
    const exact = scoreOpenings(results(['O1', ['W10', 'W12', 'W15']], ['O2', []], ['O3', []]), key).scores[0]!;
    expect(exact.first3Match).toBe(true);
  });

  it('compares by line id, so an accent difference in the name is ignored', () => {
    const k = keyOf(opening('O1', 'W39 Joël Bertin; W42 Amanda Bourgeois'));
    const res = parseResultsCsv('opening_id,shortlist\nO1,W39 Joel Bertin (506-555-0101); W42 Amanda Bourgeois (506-555-0102)\n');
    const r = scoreOpenings(res, k);
    expect(r.totals).toEqual({ openings: 1, fridayMatches: 1, first3Matches: 1 });
  });

  it('a key that covers a subset scores only those; extras go to notInKey', () => {
    const k = keyOf(opening('O2', 'none'));
    const r = scoreOpenings(results(['O1', ['W10']], ['O2', []], ['O3', ['W05']]), k);
    expect(r.scores.map((s) => s.id)).toEqual(['O2']);
    expect(r.totals.openings).toBe(1);
    expect(r.notInKey).toEqual(['O1', 'O3']);
    expect(formatReport(r, null)).toContain('Not in the key, so not scored (2): O1, O3');
  });

  it('an opening missing from results.csv is a mismatch', () => {
    const r = scoreOpenings(results(['O2', []], ['O3', ['W05']]), key);
    expect(r.scores[0]!.problem).toBe('missing from results.csv');
    expect(r.scores[0]!.fridayMatch).toBe(false);
    expect(r.totals.fridayMatches).toBe(2);
  });

  it('the report marks mismatches clearly and gives the summary', () => {
    const report = formatReport(scoreOpenings(results(['O1', ['W10', 'W99']], ['O2', []], ['O3', ['W05']]), key), null);
    expect(report).toMatch(/O1\s+MISMATCH\s+ours W10 W99 \| Tanya W10 W12 W15 W20 W30\s+<-- W99 is not on Tanya's list/);
    expect(report).toMatch(/O2\s+match\s+ours nobody \| Tanya nobody/);
    expect(report).toContain("Openings: 2/3 match (Friday rule) · 1/3 equal Tanya's first 3");
    expect(report).toContain("(not Tanya's first 3)"); // O3: one correct name, but Tanya's first 3 are W05 W06
    expect(report).toContain('Lines: not scored');
  });
});

describe('scoreLines', () => {
  const key = keyOf(line('W01', 'stale'), line('W02', 'duplicate of W51'), line('W03', 'active'));

  it('compares verdict text and lists the misses', () => {
    const l = scoreLines(new Map([['W01', 'stale'], ['W02', 'duplicate of W50'], ['W03', 'active'], ['W04', 'active']]), key);
    expect(l.totals).toEqual({ lines: 3, matches: 2 });
    expect(l.notInKey).toEqual(['W04']);
    const report = formatReport({ scores: [], totals: { openings: 0, fridayMatches: 0, first3Matches: 0 }, notInKey: [] }, l);
    expect(report).toContain('W02  MISMATCH  ours duplicate of W50 | Tanya duplicate of W51');
    expect(report).toContain('Lines: 2/3');
  });

  it('a line with no verdict is a mismatch', () => {
    expect(scoreLines(new Map(), key).totals).toEqual({ lines: 3, matches: 0 });
  });
});

describe('reading the files', () => {
  it('results: quoted cells, BOM, trailing semicolon, none', () => {
    const text = '﻿"opening_id","shortlist"\r\n"O1","W46 Shawn Duguay (506-555-0140); W53 Luc Bernard (506-555-0121);"\r\nO2,none\r\n';
    expect([...parseResultsCsv(text)]).toEqual([['O1', ['W46', 'W53']], ['O2', []]]);
  });

  it('results: a missing column is a clear error', () => {
    expect(() => parseResultsCsv('opening_id,names\nO1,none\n')).toThrow(/results file is missing column\(s\): shortlist/);
  });

  it('results: a malformed row names the opening and the entry', () => {
    expect(() => parseResultsCsv('opening_id,shortlist\nO7,Luc Bernard (506-555-0121)\n')).toThrow(/opening O7.*"Luc Bernard/);
    expect(() => parseResultsCsv('opening_id,shortlist\nO7,W46 Shawn; none\n')).toThrow(/opening O7/);
    expect(() => parseResultsCsv('opening_id,shortlist\nO7,\n')).toThrow(/opening O7/);
    expect(() => parseResultsCsv('opening_id,shortlist\nO7,none\nO7,none\n')).toThrow(/more than once/);
  });

  it('answer key: the real key has 44 openings and 60 lines', () => {
    const key = parseAnswerKey(sampleText('answer-key-tanya.csv'));
    expect(key.openings.size).toBe(44);
    expect(key.lines.size).toBe(60);
    expect(key.openings.get('O01')).toEqual(['W39', 'W42', 'W45', 'W57']);
    expect(key.openings.get('O02')).toEqual([]);
    expect(key.lines.get('W02')).toBe('duplicate of W51');
  });

  it('answer key: missing columns and an empty key are errors', () => {
    expect(() => parseAnswerKey('id,type,answer\nO1,opening,none\n')).toThrow(/answer key file is missing column\(s\): marked_by, note/);
    expect(() => parseAnswerKey(`${KEY_HEADER}\n`)).toThrow(/no opening rows/);
  });

  it('line verdicts: needs line and verdict', () => {
    expect(() => parseLineVerdictsCsv('line,reason\nW01,x\n')).toThrow(/verdict/);
    expect(parseLineVerdictsCsv('line,verdict,reason\nW01,stale,"too old, sorry"\n').get('W01')).toBe('stale');
  });
});
