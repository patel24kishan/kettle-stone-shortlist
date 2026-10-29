// npm run check:done (feature 7): the build plan's section 7 done checks as one command.
// Prints ✅ / ❌ per item with what was seen; exit 0 when every item passes, 1 otherwise.
//
// Everything runs in a fresh temp folder: the sample files are only read, and nothing is written to data/sample/,
// runs/ or .data/ (the last item checks that). Claude is never called: the child processes get no ANTHROPIC_API_KEY
// and never read .env.local, and the in-process import gets no client. So it runs offline, on the saved readings.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStore } from '../src/lib/storage/local';
import { importFiles } from '../src/lib/server/import-service';
import { searchFile } from '../src/lib/server/search-service';
import { parseAnswerKey, parseLineVerdictsCsv, parseResultsCsv, scoreLines, scoreOpenings } from '../src/lib/score';
import {
  REHEARSAL_EXTRA_LINES,
  REHEARSAL_RUN_DATE,
  differingOpenings,
  formatItem,
  formatSummary,
  noShowIds,
  notNobody,
  readmeMissing,
  rehearsalOpeningsCsv,
  rehearsalWaitlist,
  scanForHealthDetail,
  waitlistNotes,
} from '../src/lib/done-checks';
import type { DoneItem, ScannedFile } from '../src/lib/done-checks';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'data', 'sample');
const FILES = {
  waitlist: path.join(SAMPLE, 'waitlist-2026-10-21.csv'),
  appointments: path.join(SAMPLE, 'appointments-2026-09-21-to-2026-10-17.csv'),
  openings: path.join(SAMPLE, 'late-openings-2026-09-21-to-2026-10-17.csv'),
  key: path.join(SAMPLE, 'answer-key-tanya.csv'),
};
const SAMPLE_RUN_DATE = '2026-10-21';
const NOBODY_TOO = ['O31', 'O40'];
const OUTPUT_FILES = ['results.csv', 'line_verdicts.csv', 'run.json'];

const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
const items: DoneItem[] = [];
const add = (ok: boolean, title: string, ...evidence: string[]) => {
  const item = { ok, title, evidence };
  items.push(item);
  console.log(formatItem(item));
};

// ---- child processes -------------------------------------------------------------------------------------

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SHORTLIST_SKIP_ENV_FILE: '1' };
  delete env.ANTHROPIC_API_KEY; // never a real Claude call
  return env;
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** node <entry> ...args in the project folder, no shell (the folder name has spaces). */
function spawn(entry: string, args: string[], timeout: number): Spawned {
  const start = Date.now();
  const res = spawnSync(process.execPath, [path.join(ROOT, entry), ...args], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms: Date.now() - start };
}

const TSX = 'node_modules/tsx/dist/cli.mjs';
const shortlist = (args: string[]) => spawn(TSX, ['scripts/shortlist.ts', ...args], 120_000);

interface Run extends Spawned {
  outDir: string;
  files: Record<string, string | null>;
}

function runCli(inputs: { waitlist: string; appointments: string; openings: string }, runDate: string, outDir: string, cache: string): Run {
  const res = shortlist([
    'run',
    '--waitlist', inputs.waitlist,
    '--appointments', inputs.appointments,
    '--openings', inputs.openings,
    '--run-date', runDate,
    '--out-dir', outDir,
    '--cache', cache,
  ]);
  const files = Object.fromEntries(
    OUTPUT_FILES.map((f) => [f, fs.existsSync(path.join(outDir, f)) ? read(path.join(outDir, f)) : null]),
  );
  return { ...res, outDir, files };
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
const failText = (r: Spawned) => `exit ${r.code}: ${lastLine(r.stderr) || lastLine(r.stdout) || 'no output'}`;

// ---- nothing written to the project's own folders ---------------------------------------------------------

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = path.join(e.parentPath, e.name);
    out.set(path.relative(dir, full), createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return out;
}
const PROTECTED = ['data/sample', 'runs', '.data'];
const changedFiles = (a: Map<string, string>, b: Map<string, string>) =>
  [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));

// ---- the checks ---------------------------------------------------------------------------------------------

function checkTests(tmp: string): void {
  const out = path.join(tmp, 'vitest.json');
  const res = spawn('node_modules/vitest/vitest.mjs', ['run', '--reporter=json', `--outputFile=${out}`], 900_000);
  if (!fs.existsSync(out)) {
    add(false, 'Unit and integration tests pass', `vitest wrote no report (${failText(res)})`);
    return;
  }
  const report = JSON.parse(fs.readFileSync(out, 'utf8')) as {
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests?: number;
    numTodoTests?: number;
    testResults: { name: string; status: string; assertionResults: { status: string; fullName?: string; title: string }[] }[];
  };
  const files = report.testResults.map((r) => path.relative(ROOT, r.name).replace(/\\/g, '/'));
  const unit = files.filter((f) => f.startsWith('tests/unit/')).length;
  const integration = files.filter((f) => f.startsWith('tests/integration/')).length;
  const failedFiles = report.testResults.filter((r) => r.status !== 'passed');
  const ok = res.code === 0 && report.numFailedTests === 0 && failedFiles.length === 0 && report.numPassedTests > 0;
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  const evidence = [
    `${report.numPassedTests} passed, ${report.numFailedTests} failed${skipped ? `, ${skipped} skipped` : ''} of ${report.numTotalTests} ` +
      `(${files.length} files: ${unit} unit, ${integration} integration; ${Math.round(res.ms / 1000)} s)`,
  ];
  for (const r of failedFiles.slice(0, 5)) {
    const bad = r.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName ?? a.title);
    evidence.push(`failed: ${path.relative(ROOT, r.name)}${bad.length ? ` > ${bad.slice(0, 3).join(' | ')}` : ''}`);
  }
  add(ok, 'Unit and integration tests pass', ...evidence);
}

async function main(): Promise<number> {
  const started = Date.now();
  console.log(`Done checks (build-plan section 7) · ${new Date().toISOString().slice(0, 10)} · ${ROOT}`);
  console.log('Offline: no Claude calls, saved readings only. Temp folder only; the sample files are read, never written.');
  console.log('');

  const before = new Map(PROTECTED.map((d) => [d, snapshot(path.join(ROOT, d))]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-check-done-'));
  let keep = false;
  try {
    // 1. Tests.
    checkTests(tmp);

    // 2. The sample: run twice (for determinism), score the first.
    const a = runCli(FILES, SAMPLE_RUN_DATE, path.join(tmp, 'sample-a'), path.join(tmp, 'cache-sample-a.json'));
    const b = runCli(FILES, SAMPLE_RUN_DATE, path.join(tmp, 'sample-b'), path.join(tmp, 'cache-sample-b.json'));
    const sampleOk = a.code === 0 && a.files['results.csv'] !== null && a.files['line_verdicts.csv'] !== null;
    const key = parseAnswerKey(read(FILES.key));

    if (!sampleOk) {
      add(false, 'Line verdicts match the answer key (60 lines)', `the sample run failed (${failText(a)})`);
      add(false, 'Every name shown is on the key (Friday rule), all 44 sample openings', 'the sample run failed');
      add(false, "Shortlists equal the key's first 3, all 44 sample openings", 'the sample run failed');
      add(false, 'All 8 no-shows and O31, O40 return nobody', 'the sample run failed');
    } else {
      const results = a.files['results.csv']!;
      const lines = scoreLines(parseLineVerdictsCsv(a.files['line_verdicts.csv']!), key);
      const openings = scoreOpenings(parseResultsCsv(results), key);
      const scored = shortlist(['score', '--results', path.join(a.outDir, 'results.csv'), '--key', FILES.key]);
      const scoreSays = scored.code === 0 ? `npm run shortlist -- score says "${scored.stdout.split(/\r?\n/).filter((l) => /^(Openings|Lines):/.test(l)).join(' · ')}"` : `score command ${failText(scored)}`;
      const t = openings.totals;
      const badLines = lines.scores.filter((l) => !l.match).map((l) => l.id);
      add(
        lines.totals.lines === 60 && lines.totals.matches === 60,
        'Line verdicts match the answer key (60 lines)',
        `${lines.totals.matches}/${lines.totals.lines} line verdicts${badLines.length ? `; wrong: ${badLines.join(', ')}` : ''}`,
      );
      const notFriday = openings.scores.filter((s) => !s.fridayMatch).map((s) => `${s.id} (${s.problem})`);
      add(
        t.openings === 44 && t.fridayMatches === 44 && scored.code === 0,
        'Every name shown is on the key (Friday rule), all 44 sample openings',
        `${t.fridayMatches}/${t.openings} openings${notFriday.length ? `; mismatches: ${notFriday.join(', ')}` : ''}`,
        scoreSays,
      );
      const notFirst3 = openings.scores.filter((s) => !s.first3Match).map((s) => s.id);
      add(
        t.openings === 44 && t.first3Matches === 44,
        "Shortlists equal the key's first 3, all 44 sample openings",
        `${t.first3Matches}/${t.openings} equal Tanya's first 3, in waitlist order${notFirst3.length ? `; differ: ${notFirst3.join(', ')}` : ''}`,
      );
      const noShows = noShowIds(read(FILES.openings));
      const mustBeNobody = [...noShows, ...NOBODY_TOO];
      const wrong = notNobody(results, mustBeNobody);
      add(
        noShows.length === 8 && wrong.length === 0,
        'All 8 no-shows and O31, O40 return nobody',
        `${mustBeNobody.length - wrong.length}/${mustBeNobody.length} show "none": no-shows ${noShows.join(', ')}; plus ${NOBODY_TOO.join(', ')}` +
          (wrong.length ? `; NOT nobody: ${wrong.join(', ')}` : ''),
      );
    }

    // 3. A Friday-style rehearsal on new files, with no key and no hand edits, run twice.
    const rehearsalDir = path.join(tmp, 'friday-inputs');
    fs.mkdirSync(rehearsalDir);
    const friday = {
      waitlist: path.join(rehearsalDir, `waitlist-${REHEARSAL_RUN_DATE}.csv`),
      appointments: FILES.appointments,
      openings: path.join(rehearsalDir, 'late-openings-2026-10-26-to-2026-10-31.csv'),
    };
    fs.writeFileSync(friday.waitlist, rehearsalWaitlist(read(FILES.waitlist)), 'utf8');
    fs.writeFileSync(friday.openings, rehearsalOpeningsCsv(), 'utf8');
    const f1 = runCli(friday, REHEARSAL_RUN_DATE, path.join(tmp, 'friday-a'), path.join(tmp, 'cache-friday-a.json'));
    const f2 = runCli(friday, REHEARSAL_RUN_DATE, path.join(tmp, 'friday-b'), path.join(tmp, 'cache-friday-b.json'));
    const wrote = OUTPUT_FILES.filter((f) => f1.files[f] !== null);
    const resultRows = f1.files['results.csv'] ? f1.files['results.csv'].trim().split(/\r?\n/).length - 1 : 0;
    const verdictRows = f1.files['line_verdicts.csv'] ? f1.files['line_verdicts.csv'].trim().split(/\r?\n/).length - 1 : 0;
    const summary = f1.stdout.split(/\r?\n/).find((l) => l.includes('openings searched')) ?? '';
    const warning = f1.stdout.split(/\r?\n/).find((l) => l.startsWith('WARNING')) ?? '';
    add(
      f1.code === 0 && wrote.length === 3 && resultRows === 10 && verdictRows === 60 + REHEARSAL_EXTRA_LINES.length,
      'Runs on new files with one command and no hand edits',
      f1.code === 0
        ? `exit 0; wrote ${wrote.join(', ')} (${resultRows} openings, ${verdictRows} lines) from the sample waitlist + ${REHEARSAL_EXTRA_LINES.length} new lines and a new 10-opening file, no key`
        : failText(f1),
      ...(summary ? [`CLI: ${summary.trim()}`] : []),
      ...(warning ? [`CLI: ${warning.trim().slice(0, 160)}${warning.length > 160 ? '…' : ''}`] : []),
    );

    // 4. Same input, same output.
    const same = (x: Run, y: Run, f: string) => x.files[f] !== null && x.files[f] === y.files[f];
    const pairs: [string, Run, Run][] = [['sample', a, b], ['Friday rehearsal', f1, f2]];
    const diffs = pairs.flatMap(([label, x, y]) =>
      ['results.csv', 'line_verdicts.csv'].filter((f) => !same(x, y, f)).map((f) => `${label} ${f}`),
    );
    const hash = (s: string | null) => (s === null ? 'missing' : createHash('sha256').update(s).digest('hex').slice(0, 12));
    add(
      diffs.length === 0,
      'Same input gives the same output on two runs',
      diffs.length === 0
        ? `byte-identical results.csv and line_verdicts.csv on two runs each of the sample and the rehearsal`
        : `differ: ${diffs.join(', ')}`,
      `sample results.csv sha256 ${hash(a.files['results.csv'])}…, line_verdicts.csv ${hash(a.files['line_verdicts.csv'])}…`,
    );

    // 5. Dashboard search = CLI (the Search screen's service, in-process, on a temp store).
    const store = new LocalStore(path.join(tmp, 'store'), { seedReadingsFrom: path.join(SAMPLE, 'readings.json') });
    const imported = await importFiles(
      {
        waitlist: { name: path.basename(FILES.waitlist), text: read(FILES.waitlist) },
        openings: { name: path.basename(FILES.openings), text: read(FILES.openings) },
        appointments: { name: path.basename(FILES.appointments), text: read(FILES.appointments) },
        runDate: SAMPLE_RUN_DATE,
      },
      { store, client: null },
    );
    const screen = imported.ok ? await searchFile(store, null) : null;
    const screenUpload = imported.ok ? await searchFile(store, rehearsalOpeningsCsv(), 'friday.csv') : null;
    let screenJson = '';
    if (!imported.ok || !screen?.ok || !sampleOk) {
      add(false, 'Dashboard search shows the same names as the CLI', !imported.ok ? `import failed: ${imported.message}` : !sampleOk ? 'the sample run failed' : 'search failed');
    } else {
      screenJson = JSON.stringify(screen) + JSON.stringify(screenUpload);
      const differ = differingOpenings(a.files['results.csv']!, screen.resultsCsv);
      add(
        differ.length === 0 && screen.resultsCsv === a.files['results.csv'],
        'Dashboard search shows the same names as the CLI',
        differ.length === 0
          ? `Search "All openings from a file" = results.csv for all ${screen.openings.length} openings (${screen.counts.withPeople} have people, ${screen.counts.nobody} nobody)`
          : `differ: ${differ.join(', ')}`,
      );
    }

    // 6. No health detail in any output (every file the runs wrote into their run folders, plus the screen's data).
    const scanned: ScannedFile[] = [];
    for (const run of [a, b, f1, f2]) {
      if (!fs.existsSync(run.outDir)) continue;
      for (const e of fs.readdirSync(run.outDir, { recursive: true, withFileTypes: true })) {
        if (!e.isFile()) continue;
        const full = path.join(e.parentPath, e.name);
        scanned.push({ name: path.relative(tmp, full).replace(/\\/g, '/'), text: read(full) });
      }
    }
    if (screenJson) scanned.push({ name: 'Search screen data', text: screenJson });
    const notes = [...waitlistNotes(read(FILES.waitlist)), ...waitlistNotes(read(friday.waitlist))];
    const scan = scanForHealthDetail(scanned, notes);
    const runFiles = scanned.filter((s) => s.name !== 'Search screen data');
    const kinds = [...new Set(runFiles.map((s) => s.name.split('/').pop()))].join(', ');
    add(
      runFiles.length === 4 * OUTPUT_FILES.length && scan.problems.length === 0,
      'No health detail in any output file',
      `${runFiles.length} files from 4 runs (${kinds})${screenJson ? " + the Search screen's data" : ''}: ` +
        (scan.problems.length === 0 ? 'no health words, no full waitlist notes' : `found ${scan.problems.join('; ')}`),
      'words: pregnant, pregnancy, surgery, post-op, MVA, sciatica, cancer, fibro, concussion, migraine, TMJ (whole words, any case, plurals too)',
      "not scanned: the readings cache (the tool's working file, like data/sample/readings.json; it holds the checked note quotes B5 shows)",
    );

    // 7. README.
    const readme = path.join(ROOT, 'README.md');
    if (!fs.existsSync(readme)) {
      add(false, 'README with setup and run steps', 'README.md is missing');
    } else {
      const text = read(readme);
      const missing = readmeMissing(text);
      const sections = text.split(/\r?\n/).filter((l) => l.startsWith('## ')).length;
      add(
        missing.length === 0,
        'README with setup and run steps',
        missing.length === 0
          ? `README.md (${sections} sections) covers npm install, npm run dev, shortlist run / score, check:done, npm test`
          : `README.md does not mention: ${missing.join(', ')}`,
      );
    }

    // 8. Nothing written where it must not be.
    const changed = PROTECTED.flatMap((d) => changedFiles(before.get(d)!, snapshot(path.join(ROOT, d))).map((f) => `${d}/${f}`));
    add(
      changed.length === 0,
      'Nothing written to data/sample/, runs/ or .data/',
      changed.length === 0 ? 'byte-identical before and after' : `changed: ${changed.slice(0, 10).join(', ')}`,
    );

    keep = items.some((i) => !i.ok);
  } finally {
    if (keep) console.log(`\nKept the temp folder for a look: ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log(formatSummary(items));
  console.log('Not covered here (checked by the tests above and by hand in the browser): Booked across screens, undo, two-tab sync.');
  console.log(`Took ${Math.round((Date.now() - started) / 1000)} s.`);
  return items.every((i) => i.ok) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`check:done failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  },
);
