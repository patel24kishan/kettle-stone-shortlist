'use client';
// Screen 1 "Search" (reference/mockups/A1b-Search-one-or-all.dc.html, with A1 = Main.dc.html and the nobody states
// A2 / A2b). The Search switch picks One opening or All openings from a file.
// Booked (build-plan section 4): save first, then show. The card changes only after the server confirms; a failed
// save says so and leaves the card as it was; a second booking of an opening is refused ("Already filled by ...").
// rules.md "Always": only name, phone, line number and the opening are shown; never notes or health details.
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { checkColumns } from '@/lib/csv';
import { fileCheckText } from '@/lib/input-files';
import { announceChange } from '@/lib/live/channel';
import { useLiveVersion } from '@/lib/live/use-live-version';
import {
  BOOKED_FOOTER,
  DEFAULT_LENGTH,
  JOSEE_NOTE,
  LENGTHS,
  PAGE_SIZE,
  SHORT_LINE,
  alreadyFilledText,
  bookingExportText,
  clinicNowLocal,
  countsText,
  filledView,
  filterOpenings,
  matchedAgainstText,
  moreLabel,
  searchedText,
} from '@/lib/search-view';
import type { FileFilter, OneOpeningInput, OpeningView, SearchCard } from '@/lib/search-view';
import type { SearchContext, SearchFileResult, SearchOneResult } from '@/lib/server/search-service';
import { THERAPISTS } from '@/lib/types';
import type { BookedRecord } from '@/lib/types';
import styles from './search.module.css';

type Mode = 'one' | 'file';
type FileOk = Extract<SearchFileResult, { ok: true }>;
type Note = { kind: 'error' | 'info'; text: string };
type Failure = { ok: false; message: string; noImport?: true; check?: string };

const NETWORK_ERROR = 'Could not reach the server. Check the tool is running and try again.';
const lineNumber = (lineId: string) => Number(lineId.replace(/\D/g, '')) || lineId;

// ---- icons ----------------------------------------------------------------------------------------------

function CheckIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5 10 17 19 7" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function NobodyIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
      <path d="M7.5 10.5h6" />
    </svg>
  );
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

// ---- the screen -----------------------------------------------------------------------------------------

export interface SearchScreenProps {
  initialContext: SearchContext | null;
  initialMode: Mode;
  /** YYYY-MM-DD, the clinic's today. */
  today: string;
  /** datetime-local value for "now" on the clinic's clock. */
  nowLocal: string;
}

export function SearchScreen({ initialContext, initialMode, today, nowLocal }: SearchScreenProps) {
  const uid = useId();
  const [context, setContext] = useState<SearchContext | null>(initialContext);
  const [mode, setMode] = useState<Mode>(initialMode);

  // One opening
  const [form, setForm] = useState<OneOpeningInput>({ date: today, start: '', therapist: '', length: DEFAULT_LENGTH, cancelledAt: nowLocal });
  const [cancelledTouched, setCancelledTouched] = useState(false);
  const [oneQuery, setOneQuery] = useState<OneOpeningInput | null>(null);
  const [oneView, setOneView] = useState<OpeningView | null>(null);
  const [oneError, setOneError] = useState<string | null>(null);

  // All openings from a file
  const fileInput = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<{ file: File; ok: boolean; check: string } | null>(null);
  const [fileQuery, setFileQuery] = useState<{ file: File | null } | null>(null);
  const [fileResult, setFileResult] = useState<FileOk | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FileFilter>('all');
  const [shown, setShown] = useState(PAGE_SIZE);

  const [busy, setBusy] = useState<Mode | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // "Cancelled at" defaults to now and follows the clock until Tanya changes it.
  useEffect(() => {
    if (cancelledTouched) return;
    const tick = () => setForm((f) => ({ ...f, cancelledAt: clinicNowLocal() }));
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [cancelledTouched]);

  const failed = useCallback((body: Failure | null, status: number): string => {
    if (body?.noImport) setContext(null);
    return body?.message ?? `The search did not finish (server answered ${status}).`;
  }, []);

  /** Runs one search; `quiet` = a refresh after Booked / Undo, which keeps the current view if it fails. */
  const runOne = useCallback(
    async (query: OneOpeningInput, quiet = false): Promise<boolean> => {
      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(query),
        });
        const body = await readJson<SearchOneResult>(res);
        if (!body || !body.ok) {
          const message = failed(body as Failure | null, res.status);
          if (quiet) setRefreshError(`Could not refresh the list: ${message}`);
          else setOneError(message);
          return false;
        }
        setOneView(body.opening);
        setContext(body.context);
        return true;
      } catch {
        if (quiet) setRefreshError(`Could not refresh the list. ${NETWORK_ERROR}`);
        else setOneError(NETWORK_ERROR);
        return false;
      }
    },
    [failed],
  );

  const runFile = useCallback(
    async (file: File | null, quiet = false): Promise<boolean> => {
      const data = new FormData();
      if (file) data.append('openings', file);
      try {
        const res = await fetch('/api/search/file', { method: 'POST', body: data });
        const body = await readJson<SearchFileResult>(res);
        if (!body || !body.ok) {
          const fail = body as Failure | null;
          const message = failed(fail, res.status);
          if (quiet) setRefreshError(`Could not refresh the list: ${message}`);
          else setFileError(message);
          if (fail?.check && file) setChoice({ file, ok: false, check: fail.check });
          return false;
        }
        setFileResult(body);
        setContext(body.context);
        return true;
      } catch {
        if (quiet) setRefreshError(`Could not refresh the list. ${NETWORK_ERROR}`);
        else setFileError(NETWORK_ERROR);
        return false;
      }
    },
    [failed],
  );

  /** After Booked or Undo: fetch again, so the person disappears from (or comes back to) every other opening. */
  const refresh = useCallback(async () => {
    setRefreshError(null);
    await Promise.all([oneQuery ? runOne(oneQuery, true) : null, fileQuery ? runFile(fileQuery.file, true) : null]);
  }, [oneQuery, fileQuery, runOne, runFile]);

  // Live sync (build-plan section 4): a Booked, Undo or import in another tab or device re-runs the searches shown.
  useLiveVersion({
    onChange: () => void refresh(),
    initialVersion: initialContext?.version ?? null,
    knownVersion: context?.version ?? null,
  });

  async function onSearchOne(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const query = { ...form, cancelledAt: cancelledTouched ? form.cancelledAt : clinicNowLocal() };
    const missing: string[] = [];
    if (!query.date) missing.push('the date');
    if (!query.start) missing.push('the start time');
    if (!query.therapist) missing.push('the therapist');
    if (!query.cancelledAt) missing.push('when it was cancelled');
    if (missing.length > 0) {
      setOneError(`Choose ${missing.join(', ')}.`);
      return;
    }
    setBusy('one');
    setOneError(null);
    setRefreshError(null);
    setNotes({});
    if (!cancelledTouched) setForm(query);
    if (await runOne(query)) setOneQuery(query);
    setBusy(null);
  }

  async function onSearchFile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy('file');
    setFileError(null);
    setRefreshError(null);
    setNotes({});
    const file = choice?.file ?? null;
    if (await runFile(file)) {
      setFileQuery({ file });
      setShown(PAGE_SIZE);
    }
    setBusy(null);
  }

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    setFileError(null);
    if (!file) {
      setChoice(null);
      return;
    }
    try {
      const c = checkColumns(await file.text(), 'openings');
      setChoice({ file, ok: c.ok, check: fileCheckText('openings', c.rows, c.missing) });
    } catch {
      setChoice({ file, ok: false, check: 'This file could not be read as a CSV.' });
    }
  }

  function clearChosenFile() {
    setChoice(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  /** The opening is filled: shown at once from the saved record, before the refresh comes back. */
  function showFilled(openingId: string, record: BookedRecord) {
    const patch = (o: OpeningView): OpeningView =>
      o.id === openingId ? { ...o, fitLabel: 'Filled', cards: [], short: false, nobody: null, filled: filledView(record) } : o;
    setOneView((v) => (v ? patch(v) : v));
    setFileResult((r) => (r ? { ...r, openings: r.openings.map(patch) } : r));
  }

  const setNote = (id: string, note: Note | null) =>
    setNotes((n) => {
      const next = { ...n };
      if (note) next[id] = note;
      else delete next[id];
      return next;
    });

  async function book(opening: OpeningView, card: SearchCard) {
    if (saving) return;
    setSaving(`${opening.id}:${card.lineId}`);
    setNote(opening.id, null);
    try {
      const res = await fetch('/api/booked', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ openingId: opening.id, lineId: card.lineId }),
      });
      const body = await readJson<
        { ok: true; record: BookedRecord } | { ok: false; message: string; existing?: BookedRecord; noImport?: true }
      >(res);
      if (res.ok && body?.ok) {
        showFilled(opening.id, body.record);
        setNote(opening.id, { kind: 'info', text: `Saved: ${card.name} is booked for this opening.` });
        announceChange();
        await refresh();
      } else if (res.status === 409 && body && !body.ok && body.existing) {
        setNote(opening.id, { kind: 'error', text: alreadyFilledText(body.existing) });
        await refresh();
      } else {
        const why = body && !body.ok ? body.message : `The server answered ${res.status}.`;
        setNote(opening.id, { kind: 'error', text: `Not saved: ${why}` });
        if (body && !body.ok && body.noImport) setContext(null);
      }
    } catch {
      setNote(opening.id, { kind: 'error', text: `Not saved. ${NETWORK_ERROR}` });
    } finally {
      setSaving(null);
    }
  }

  async function undo(opening: OpeningView) {
    if (saving) return;
    setSaving(`undo:${opening.id}`);
    setNote(opening.id, null);
    try {
      const res = await fetch(`/api/booked?openingId=${encodeURIComponent(opening.id)}`, { method: 'DELETE' });
      const body = await readJson<{ ok: boolean; message?: string }>(res);
      if (res.ok && body?.ok) {
        setNote(opening.id, { kind: 'info', text: 'Undone. The opening is open again.' });
        announceChange();
      } else {
        setNote(opening.id, { kind: 'error', text: `Not undone: ${body?.message ?? `the server answered ${res.status}.`}` });
      }
      await refresh();
    } catch {
      setNote(opening.id, { kind: 'error', text: `Not undone. ${NETWORK_ERROR}` });
    } finally {
      setSaving(null);
    }
  }

  if (!context) {
    return (
      <main className="page">
        <section className="card card-pad" aria-labelledby={`${uid}-none`}>
          <h1 id={`${uid}-none`} className={styles.formTitle}>
            Search
          </h1>
          <p className={styles.noImport}>
            Nothing imported yet. Import the waitlist, the late openings and the booking export in{' '}
            <Link href="/admin">Waitlist (admin)</Link> first; the search matches against that import.
          </p>
        </section>
      </main>
    );
  }

  const isOne = mode === 'one';
  const cardProps = { saving, onBook: book, onUndo: undo, notes };

  return (
    <main className="page">
      <section aria-labelledby={`${uid}-form`} className={`card ${styles.formCard}`}>
        <h1 id={`${uid}-form`} className={styles.formTitle}>
          {isOne ? 'Late opening' : 'Late openings'}
        </h1>

        <fieldset className={styles.plainFieldset}>
          <legend className={styles.legend}>Search</legend>
          <div className={styles.switch}>
            {(['one', 'file'] as const).map((m) => (
              <label key={m} className={`${styles.switchOption} ${mode === m ? styles.switchOn : ''}`}>
                <input type="radio" name={`${uid}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} className={styles.radio} />
                {m === 'one' ? 'One opening' : 'All openings from a file'}
              </label>
            ))}
          </div>
        </fieldset>

        {isOne ? (
          <form onSubmit={onSearchOne} noValidate className={styles.formBody}>
            <div className={styles.fields}>
              <div className="field">
                <label htmlFor={`${uid}-date`}>Date</label>
                <input
                  id={`${uid}-date`}
                  type="date"
                  required
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.currentTarget.value })}
                  className={`${styles.input} ${styles.wDate}`}
                />
              </div>
              <div className="field">
                <label htmlFor={`${uid}-time`}>Start time</label>
                <input
                  id={`${uid}-time`}
                  type="time"
                  required
                  value={form.start}
                  onChange={(e) => setForm({ ...form, start: e.currentTarget.value })}
                  className={`${styles.input} ${styles.wTime}`}
                />
              </div>
              <div className="field">
                <label htmlFor={`${uid}-ther`}>Therapist</label>
                <select
                  id={`${uid}-ther`}
                  required
                  value={form.therapist}
                  onChange={(e) => setForm({ ...form, therapist: e.currentTarget.value })}
                  className={`${styles.input} ${styles.wTher}`}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {THERAPISTS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className={styles.plainFieldset}>
                <legend className={styles.legend}>Length</legend>
                <div className={styles.lengths}>
                  {LENGTHS.map((len) => (
                    <label key={len} className={`${styles.lengthOption} ${form.length === len ? styles.lengthOn : ''}`}>
                      <input
                        type="radio"
                        name={`${uid}-len`}
                        value={len}
                        checked={form.length === len}
                        onChange={() => setForm({ ...form, length: len })}
                        className={styles.radio}
                      />
                      {len} min
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="field">
                <label htmlFor={`${uid}-cancel`}>Cancelled at</label>
                <input
                  id={`${uid}-cancel`}
                  type="datetime-local"
                  required
                  value={form.cancelledAt}
                  onChange={(e) => {
                    setCancelledTouched(true);
                    setForm({ ...form, cancelledAt: e.currentTarget.value });
                  }}
                  aria-describedby={`${uid}-cancel-hint`}
                  className={`${styles.input} ${styles.wCancel}`}
                />
                <span id={`${uid}-cancel-hint`} className={styles.hint}>
                  {cancelledTouched ? 'Used to count the notice.' : 'Now, unless you change it. Used to count the notice.'}
                </span>
              </div>
            </div>
            <div className={styles.actions}>
              <button type="submit" className={styles.primary} disabled={busy === 'one'} aria-busy={busy === 'one'}>
                {busy === 'one' ? 'Searching…' : 'Search waitlist'}
              </button>
              <span className={styles.meta}>{bookingExportText(context.bookingExportDate)}</span>
            </div>
            <ErrorBox text={oneError} />
          </form>
        ) : (
          <form onSubmit={onSearchFile} noValidate className={styles.formBody}>
            <div className={styles.fields}>
              <div className="field">
                <label htmlFor={`${uid}-file`}>Late openings CSV</label>
                <div className={styles.filePick}>
                  <input
                    ref={fileInput}
                    id={`${uid}-file`}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={onPickFile}
                    aria-describedby={`${uid}-file-check ${uid}-file-src`}
                    className={styles.fileInput}
                  />
                  <span id={`${uid}-file-src`} className={styles.fileName}>
                    {choice ? choice.file.name : (
                      <>
                        <span className="visually-hidden">No file chosen, so this uses the imported file: </span>
                        {context.openingsFile.name}
                      </>
                    )}
                  </span>
                </div>
              </div>
              <span id={`${uid}-file-check`} className={`${styles.check} ${choice && !choice.ok ? styles.checkBad : ''}`}>
                {choice && !choice.ok ? <CrossIcon /> : <CheckIcon color="#047857" />}
                {choice ? choice.check : context.openingsFile.check}
              </span>
            </div>
            <p className={styles.note}>
              {choice ? (
                <>
                  Searching the file you chose.{' '}
                  <button type="button" className={styles.textButton} onClick={clearChosenFile}>
                    Use the imported file instead
                  </button>
                </>
              ) : (
                'No file chosen: this searches the late openings file imported in Waitlist (admin).'
              )}
            </p>
            <p className={styles.note}>{matchedAgainstText(context.runDate, context.peopleReady)}</p>
            <div className={styles.actions}>
              <button type="submit" className={styles.primary} disabled={busy === 'file'} aria-busy={busy === 'file'}>
                {busy === 'file' ? 'Searching…' : 'Search all openings'}
              </button>
              <span className={styles.meta}>{bookingExportText(context.bookingExportDate)}</span>
            </div>
            <ErrorBox text={fileError} />
          </form>
        )}
      </section>

      <div aria-live="polite" className={styles.results}>
        <ErrorBox text={refreshError} />
        {isOne
          ? oneView && <OneResult uid={uid} view={oneView} {...cardProps} />
          : fileResult && (
              <FileResults
                uid={uid}
                result={fileResult}
                filter={filter}
                shown={shown}
                onFilter={(f) => {
                  setFilter(f);
                  setShown(PAGE_SIZE);
                }}
                onMore={(n) => setShown(n)}
                {...cardProps}
              />
            )}
      </div>
    </main>
  );
}

// ---- pieces ---------------------------------------------------------------------------------------------

function ErrorBox({ text }: { text: string | null }) {
  return (
    <div role="alert">
      {text && (
        <div className="alert alert-error">
          <CrossIcon />
          <span>{text}</span>
        </div>
      )}
    </div>
  );
}

interface CardProps {
  saving: string | null;
  notes: Record<string, Note>;
  onBook: (o: OpeningView, c: SearchCard) => void;
  onUndo: (o: OpeningView) => void;
}

function OpeningNote({ note }: { note: Note | undefined }) {
  if (!note) return null;
  return note.kind === 'error' ? (
    <div className="alert alert-error" role="alert">
      <CrossIcon />
      <span>{note.text}</span>
    </div>
  ) : (
    <p className={styles.saved} role="status">
      <CheckIcon color="#047857" />
      {note.text}
    </p>
  );
}

function OpeningBody({ view, big, saving, notes, onBook, onUndo }: CardProps & { view: OpeningView; big: boolean }) {
  const savingHere = saving?.startsWith(`${view.id}:`) ?? false;
  return (
    <>
      {view.joseeNote && <p className={styles.josee}>{JOSEE_NOTE}</p>}
      <OpeningNote note={notes[view.id]} />
      {view.filled ? (
        <div className={styles.filled}>
          <span className={styles.filledIcon}>
            <CheckIcon color="#FFFFFF" />
          </span>
          <div className={styles.filledText}>
            <p className={styles.filledHead}>Booked: {view.filled.name}</p>
            <p className={styles.filledSub}>
              Waitlist line {lineNumber(view.filled.lineId)} · marked {view.filled.atText}. This opening is filled.
            </p>
          </div>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => onUndo(view)}
            disabled={saving !== null}
            aria-busy={saving === `undo:${view.id}`}
            aria-label={`Undo: ${view.filled.name} is not booked for this opening`}
          >
            {saving === `undo:${view.id}` ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      ) : view.cards.length > 0 ? (
        <>
          <ol className={styles.cards} aria-label="People to call, in waitlist order">
            {view.cards.map((c) => (
              <li key={c.lineId} className={`${styles.person} ${big ? styles.personBig : ''}`}>
                <div className={styles.personHead}>
                  <span className={styles.num} aria-hidden="true">
                    {c.n}
                  </span>
                  <span className={styles.personName}>{c.name}</span>
                </div>
                <a href={c.tel} className={styles.phone} aria-label={`Call ${c.name}, ${c.phone}`}>
                  {c.phone}
                </a>
                <span className={styles.line}>Waitlist line {lineNumber(c.lineId)}</span>
                <button
                  type="button"
                  className={styles.booked}
                  onClick={() => onBook(view, c)}
                  disabled={savingHere || saving !== null}
                  aria-busy={saving === `${view.id}:${c.lineId}`}
                  aria-label={`Booked: ${c.name} said yes and is booked in Kneadly`}
                >
                  <CheckIcon />
                  {saving === `${view.id}:${c.lineId}` ? 'Saving…' : 'Booked'}
                </button>
              </li>
            ))}
          </ol>
          {view.short && <p className={styles.footer}>{SHORT_LINE}</p>}
        </>
      ) : view.nobody ? (
        <div className={big ? styles.nobodyBig : styles.nobody}>
          <NobodyIcon size={big ? 30 : 28} />
          <div className={styles.nobodyText}>
            <p className={styles.nobodyHead}>{view.nobody.head}</p>
            <p className={styles.nobodyWhy}>{view.nobody.why}</p>
          </div>
        </div>
      ) : null}
    </>
  );
}

function OneResult({ uid, view, ...rest }: CardProps & { uid: string; view: OpeningView }) {
  return (
    <section aria-labelledby={`${uid}-one`} className={styles.resultSection}>
      <div className={styles.resultHead}>
        <h2 id={`${uid}-one`} className={styles.h2}>
          {view.fitLabel}
        </h2>
        <span className={styles.summary}>{view.summary}</span>
      </div>
      <OpeningBody view={view} big {...rest} />
      {view.cards.length > 0 && <p className={styles.footer}>{BOOKED_FOOTER}</p>}
    </section>
  );
}

const FILTERS: { key: FileFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'fit', label: 'People fit' },
  { key: 'nobody', label: 'Nobody' },
];

function FileResults({
  uid,
  result,
  filter,
  shown,
  onFilter,
  onMore,
  ...rest
}: CardProps & {
  uid: string;
  result: FileOk;
  filter: FileFilter;
  shown: number;
  onFilter: (f: FileFilter) => void;
  onMore: (n: number) => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = filterOpenings(result.openings, filter);
  const visible = list.slice(0, shown);
  const more = moreLabel(list.length, visible.length);
  const count = (key: FileFilter) => filterOpenings(result.openings, key).length;

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : FILTERS.length - 1)) % FILTERS.length;
    onFilter(FILTERS[next]!.key);
    tabRefs.current[next]?.focus();
  }

  function download() {
    const url = URL.createObjectURL(new Blob([result.resultsCsv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'results.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section aria-labelledby={`${uid}-res`} className={styles.resultSection}>
      <div className={styles.fileHead}>
        <div className={styles.resultHead}>
          <h2 id={`${uid}-res`} className={styles.h2}>
            {searchedText(result.counts.searched)}
          </h2>
          <span className={styles.summary}>{countsText(result.counts)}</span>
        </div>
        <button type="button" className={styles.secondary} onClick={download}>
          Download results.csv
        </button>
      </div>
      <p className={styles.meta}>
        {result.source === 'imported' ? 'Imported file' : 'File'}: <span className={styles.mono}>{result.fileName}</span>
      </p>

      <div role="tablist" aria-label="Show" className={styles.tabs}>
        {FILTERS.map((f, i) => (
          <button
            key={f.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${f.key}`}
            aria-selected={filter === f.key}
            aria-controls={`${uid}-list`}
            tabIndex={filter === f.key ? 0 : -1}
            onClick={() => onFilter(f.key)}
            onKeyDown={(e) => onTabKey(e, i)}
            className={`${styles.tab} ${filter === f.key ? styles.tabOn : ''}`}
          >
            {f.label} · {count(f.key)}
          </button>
        ))}
      </div>

      <div id={`${uid}-list`} role="tabpanel" aria-labelledby={`${uid}-tab-${filter}`} className={styles.openingList}>
        {visible.length === 0 && <p className={styles.footer}>No openings here.</p>}
        {visible.map((o) => (
          <section key={o.id} aria-labelledby={`${uid}-o-${o.id}`} className={styles.opening}>
            <div className={styles.resultHead}>
              <span className={styles.summarySmall}>{o.summary}</span>
              <h3 id={`${uid}-o-${o.id}`} className={styles.h3}>
                {o.id} · {o.fitLabel}
              </h3>
            </div>
            <OpeningBody view={o} big={false} {...rest} />
          </section>
        ))}
      </div>

      <div className={styles.moreRow}>
        {more && (
          <button type="button" className={styles.more} onClick={() => onMore(list.length)}>
            {more}
          </button>
        )}
        <span className={styles.footer}>{BOOKED_FOOTER}</span>
      </div>
    </section>
  );
}
