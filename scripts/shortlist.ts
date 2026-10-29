// The Friday command (build-plan.md section 6 Step 4):
//   npm run shortlist -- run --waitlist <csv> --appointments <csv> --openings <csv> --run-date YYYY-MM-DD
//                            [--out results.csv] [--out-dir runs/<run-date>] [--cache .data/readings-cache.json]
//   npm run shortlist -- score --results <results.csv> --key <answer-key.csv> [--verdicts <line_verdicts.csv>]
// Exit codes: 0 done, 1 a file could not be used, 2 bad arguments or unknown command.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { openRunCache } from '../src/lib/cache-setup';
import { InputFilesError, describeProblems, lineVerdictsCsv, resultsCsv, runShortlist } from '../src/lib/run';
import type { RunOutput } from '../src/lib/run';
import {
  formatReport,
  parseAnswerKey,
  parseLineVerdictsCsv,
  parseResultsCsv,
  scoreLines,
  scoreOpenings,
} from '../src/lib/score';
import { DEFAULT_SETTINGS } from '../src/lib/types';

const USAGE = `Usage:
  npm run shortlist -- run --waitlist <csv> --appointments <csv> --openings <csv> --run-date YYYY-MM-DD
                           [--out <results.csv>] [--out-dir <folder>] [--cache <file.json>]
  npm run shortlist -- score --results <results.csv> --key <answer-key.csv> [--verdicts <line_verdicts.csv>]

Commands:
  run     Suggest up to 3 waitlist people for each late opening, or nobody.
  score   Compare a results.csv (and line_verdicts.csv) with Tanya's answer key. Reads files only.

Options for run:
  --waitlist       Waitlist CSV (line, added, name, phone, notes)
  --appointments   Booking export CSV
  --openings       Late openings CSV
  --run-date       The date the waitlist is read for, YYYY-MM-DD (the run year is this date's year)
  --out            Also write results.csv to this path
  --out-dir        Run folder (default: runs/<run-date>/): results.csv, line_verdicts.csv, run.json
  --cache          Saved note readings (default: .data/readings-cache.json, created from the sample readings)

Options for score:
  --results        results.csv from a run (opening_id, shortlist)
  --key            Tanya's answer key CSV (it may cover only some of the openings)
  --verdicts       line_verdicts.csv from the same run (default: the one next to the results file, if there is one)

Set ANTHROPIC_API_KEY to let Claude read notes that have no saved reading.`;

class UsageError extends Error {}

type Command = (argv: string[]) => Promise<number>;

// ---- helpers ---------------------------------------------------------------------------------------------

function isRealIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** UTF-8 text, BOM removed. */
function decode(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const rel = (p: string): string => {
  const r = path.relative(process.cwd(), p);
  return r === '' || r.startsWith('..') || path.isAbsolute(r) ? p : r;
};

const same = (a: string, b: string): boolean => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// ---- run ---------------------------------------------------------------------------------------------------

interface RunArgs {
  waitlist: string;
  appointments: string;
  openings: string;
  runDate: string;
  out: string | null;
  outDir: string;
  cache: string;
}

function parseRunArgs(argv: string[]): RunArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        waitlist: { type: 'string' },
        appointments: { type: 'string' },
        openings: { type: 'string' },
        'run-date': { type: 'string' },
        out: { type: 'string' },
        'out-dir': { type: 'string' },
        cache: { type: 'string' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const missing = (['waitlist', 'appointments', 'openings', 'run-date'] as const).filter((k) => !values[k]);
  if (missing.length > 0) throw new UsageError(`Missing required option(s): ${missing.map((m) => `--${m}`).join(', ')}.`);
  const runDate = values['run-date']!;
  if (!isRealIsoDate(runDate)) throw new UsageError(`--run-date must be a real date written YYYY-MM-DD (got "${runDate}").`);
  return {
    waitlist: values.waitlist!,
    appointments: values.appointments!,
    openings: values.openings!,
    runDate,
    out: values.out ?? null,
    outDir: values['out-dir'] ?? path.join('runs', runDate),
    cache: values.cache ?? path.join('.data', 'readings-cache.json'),
  };
}

function readInput(label: string, file: string): { bytes: Buffer; text: string } {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new Error(`Cannot read the ${label} file: ${file}`);
  }
  return { bytes, text: decode(bytes) };
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function readCounts(out: RunOutput) {
  const counts = { cached: 0, claude: 0, notRead: 0, failed: 0 };
  for (const r of out.reads.values()) {
    if (r.status === 'cached') counts.cached++;
    else if (r.status === 'claude') counts.claude++;
    else if (r.status === 'failed') counts.failed++;
    else counts.notRead++;
  }
  return counts;
}

const runCommand: Command = async (argv) => {
  const args = parseRunArgs(argv);
  const inputs = {
    waitlist: { path: args.waitlist, ...readInput('waitlist', args.waitlist) },
    appointments: { path: args.appointments, ...readInput('appointments', args.appointments) },
    openings: { path: args.openings, ...readInput('late openings', args.openings) },
  };

  const outDir = path.resolve(args.outDir);
  const resultsPath = path.join(outDir, 'results.csv');
  const verdictsPath = path.join(outDir, 'line_verdicts.csv');
  const runJsonPath = path.join(outDir, 'run.json');
  const extraOut = args.out ? path.resolve(args.out) : null;
  // Never overwrite an input or one of the run's own other files with --out.
  if (extraOut) {
    const protectedPaths = [args.waitlist, args.appointments, args.openings, verdictsPath, runJsonPath];
    if (protectedPaths.some((p) => same(p, extraOut))) {
      throw new UsageError(`--out ${args.out} would overwrite an input file or another file of this run.`);
    }
  }

  loadEnvLocal();
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  const client = apiKey ? new Anthropic({ apiKey }) : null;
  const cache = openRunCache(args.cache);

  let out: RunOutput;
  try {
    out = await runShortlist({
      waitlistText: inputs.waitlist.text,
      appointmentsText: inputs.appointments.text,
      openingsText: inputs.openings.text,
      runDate: args.runDate,
      cache,
      client,
      booked: [], // a command-line run starts with no Booked marks (rules.md "Always")
      settings: DEFAULT_SETTINGS,
    });
  } catch (err) {
    if (err instanceof InputFilesError) {
      const names = { waitlist: args.waitlist, appointments: args.appointments, openings: args.openings };
      throw new Error(describeProblems(err.problems, names));
    }
    throw err;
  }

  const results = resultsCsv(out.results);
  writeText(resultsPath, results);
  writeText(verdictsPath, lineVerdictsCsv(out.lines, out.verdicts, out.reasons));
  if (extraOut) writeText(extraOut, results);

  const counts = readCounts(out);
  const runJson = {
    runDate: out.runDate,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([k, f]) => [k, { file: path.basename(f.path), sha256: sha256(f.bytes) }]),
    ),
    settings: DEFAULT_SETTINGS,
    summary: out.summary,
    // cached and claude are one number here: whether Claude read a person now or an earlier run saved it
    // must not change this file for the same input.
    readings: { read: counts.cached + counts.claude, notRead: counts.notRead, failed: counts.failed },
    createdAt: new Date().toISOString(),
  };
  writeText(runJsonPath, `${JSON.stringify(runJson, null, 2)}\n`);

  const s = out.summary;
  console.log(`Run date ${out.runDate}`);
  console.log(`${s.openings} openings searched · ${s.withPeople} have people · ${s.nobody} nobody (${s.noShows} no-shows)`);
  console.log(`Waitlist: ${s.linesRead} lines · ${s.peopleActive - s.notRead.length - s.failed.length} people ready · ${s.stale} stale lines · ${s.duplicates} repeat lines merged`);
  console.log(`Readings: ${counts.cached} saved/cached · ${counts.claude} read by Claude · ${counts.notRead} not read` + (counts.failed ? ` · ${counts.failed} failed` : ''));
  console.log('Wrote:');
  for (const p of [resultsPath, verdictsPath, runJsonPath, ...(extraOut ? [extraOut] : [])]) console.log(`  ${rel(p)}`);

  if (s.notRead.length > 0) {
    console.log('');
    console.log(
      `WARNING: ${s.notRead.length} ${s.notRead.length === 1 ? 'person was' : 'people were'} not read (${s.notRead.join(', ')}). ` +
        'They have no saved reading, so they were not offered for any opening. ' +
        'Set ANTHROPIC_API_KEY so Claude can read them, then run again.',
    );
  }
  if (s.failed.length > 0) {
    console.log('');
    console.log(
      `WARNING: Claude could not read ${s.failed.length} ${s.failed.length === 1 ? 'person' : 'people'} (${s.failed.join(', ')}). ` +
        'They were not offered for any opening. Run again to retry.',
    );
  }
  return 0;
};

// ---- score -------------------------------------------------------------------------------------------------

interface ScoreArgs {
  results: string;
  key: string;
  verdicts: string | null;
}

function parseScoreArgs(argv: string[]): ScoreArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        results: { type: 'string' },
        key: { type: 'string' },
        verdicts: { type: 'string' },
      },
    }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const missing = (['results', 'key'] as const).filter((k) => !values[k]);
  if (missing.length > 0) throw new UsageError(`Missing required option(s): ${missing.map((m) => `--${m}`).join(', ')}.`);
  return { results: values.results!, key: values.key!, verdicts: values.verdicts ?? null };
}

/** Runs a parser and puts the file's path in front of its message. */
function parseFile<T>(label: string, file: string, parse: (text: string) => T, text: string): T {
  try {
    return parse(text);
  } catch (err) {
    throw new Error(`Cannot use the ${label} file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const scoreCommand: Command = async (argv) => {
  const args = parseScoreArgs(argv);
  const results = parseFile('results', args.results, parseResultsCsv, readInput('results', args.results).text);
  const key = parseFile('answer key', args.key, parseAnswerKey, readInput('answer key', args.key).text);

  let verdictsFile = args.verdicts;
  if (!verdictsFile) {
    const sibling = path.join(path.dirname(path.resolve(args.results)), 'line_verdicts.csv');
    if (fs.existsSync(sibling)) verdictsFile = sibling;
  }
  const verdicts = verdictsFile
    ? parseFile('line verdicts', verdictsFile, parseLineVerdictsCsv, readInput('line verdicts', verdictsFile).text)
    : null;

  const openings = scoreOpenings(results, key);
  const lines = verdicts ? scoreLines(verdicts, key) : null;

  console.log(`Results:  ${rel(path.resolve(args.results))}`);
  console.log(`Key:      ${rel(path.resolve(args.key))}`);
  console.log(`Verdicts: ${verdictsFile ? rel(path.resolve(verdictsFile)) : 'none (lines not scored)'}`);
  console.log('');
  process.stdout.write(formatReport(openings, lines));
  return 0;
};

// ---- subcommands -------------------------------------------------------------------------------------------

/**
 * The setup guide puts the key in .env.local (as Next.js reads it), so the CLI loads that file too. Values already
 * in the environment win. SHORTLIST_SKIP_ENV_FILE=1 skips it, so tests never pick up a real key.
 */
function loadEnvLocal(): void {
  if (process.env.SHORTLIST_SKIP_ENV_FILE === '1') return;
  const file = path.resolve('.env.local');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trimStart().startsWith('#')) continue;
    const [, name, value] = m;
    if (process.env[name!] === undefined) process.env[name!] = value!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

const COMMANDS: Record<string, Command> = {
  run: runCommand,
  score: scoreCommand,
};

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  const handler = command === undefined ? undefined : COMMANDS[command];
  if (!handler) {
    console.error(command === undefined ? 'No command given.' : `Unknown command: ${command}`);
    console.error(USAGE);
    return 2;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  try {
    return await handler(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n`);
      console.error(USAGE);
      return 2;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
