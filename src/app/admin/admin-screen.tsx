'use client';
// B5 screen (reference/mockups/B5-Admin-waitlist.dc.html). Shows names, phones, line ids and the validated note
// wording only; never notes or health details (rules.md "Always").
import { useCallback, useId, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { longDate, timestampText } from '@/lib/format';
import { FILE_LABELS, INPUT_KINDS } from '@/lib/input-files';
import { announceChange } from '@/lib/live/channel';
import { useLiveVersion } from '@/lib/live/use-live-version';
import type { InputKind } from '@/lib/input-files';
import type { AdminView, FileCheck } from '@/lib/server/views';
import styles from './admin.module.css';

type Checks = Partial<Record<InputKind, FileCheck>>;

const checksFrom = (files: FileCheck[]): Checks => Object.fromEntries(files.map((f) => [f.kind, f]));

function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#047857" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

function WarnIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2 21h20L12 3z" />
      <path d="M12 10v5M12 18v.5" />
    </svg>
  );
}

interface ImportFailure {
  ok: false;
  message: string;
  files: FileCheck[];
}

export function AdminScreen({
  initial,
  defaultRunDate,
  initialVersion = null,
}: {
  initial: AdminView | null;
  defaultRunDate: string;
  /** The store's version when the page was loaded (live sync reloads the view when it changes). */
  initialVersion?: number | null;
}) {
  const uid = useId();
  const [view, setView] = useState<AdminView | null>(initial);
  const [checks, setChecks] = useState<Checks>(initial ? checksFrom(initial.files) : {});
  const [chosen, setChosen] = useState<Partial<Record<InputKind, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosenNow = useRef(chosen);
  chosenNow.current = chosen;

  // Live sync (build-plan section 4): a Booked, Undo or import elsewhere changes the counts and "Not offered, and
  // why", so the view is loaded again. Files being picked in this tab are left alone.
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/admin', { cache: 'no-store' });
      const body = (await res.json().catch(() => null)) as AdminView | { empty: true } | null;
      if (!res.ok || !body || 'empty' in body) return;
      setView(body);
      setChecks((prev) => {
        const fresh = checksFrom(body.files);
        for (const kind of Object.keys(chosenNow.current) as InputKind[]) fresh[kind] = prev[kind];
        return fresh;
      });
    } catch {
      // Offline: the next change tries again.
    }
  }, []);
  useLiveVersion({ onChange: () => void reload(), initialVersion });

  const onPick = (kind: InputKind) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    setChosen((c) => ({ ...c, [kind]: file?.name }));
    setChecks((c) => ({ ...c, [kind]: undefined }));
    setDone(null);
  };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const missing = INPUT_KINDS.filter((k) => {
      const f = form.get(k);
      return !(f instanceof File) || f.size === 0;
    });
    if (missing.length > 0) {
      setError(`Choose a file for: ${missing.map((k) => FILE_LABELS[k].label).join(', ')}.`);
      setDone(null);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/import', { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as
        | { ok: true; view: AdminView }
        | ImportFailure
        | null;
      if (!body) {
        setError(`The import did not finish (server answered ${res.status}). Nothing was saved.`);
      } else if (!body.ok) {
        setError(`${body.message} Nothing was saved.`);
        if (body.files.length > 0) setChecks(checksFrom(body.files));
      } else {
        setView(body.view);
        setChecks(checksFrom(body.view.files));
        setChosen({});
        const c = body.view.counts;
        setDone(`Imported. ${c.linesRead} waitlist lines read · ${c.peopleReady} people ready to match.`);
        announceChange();
      }
    } catch {
      setError('Could not reach the server, so nothing was imported. Check the tool is running and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="page-intro">
        <h1>Waitlist</h1>
        <p>
          Import the waitlist and the late openings. Each person&apos;s notes are read and sorted into preferred
          therapist, length, availability and notice, so the search can pick the right 3.
        </p>
      </div>

      <section aria-labelledby={`${uid}-import`} className="card card-pad">
        <div className="section-head">
          <h2 id={`${uid}-import`}>1 · Import files</h2>
          <p>The clinic&apos;s CSV files as they are, with the same columns as always. The files are never changed.</p>
        </div>

        <form onSubmit={onSubmit} noValidate aria-describedby={`${uid}-status`} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {INPUT_KINDS.map((kind) => {
            const id = `${uid}-${kind}`;
            const check = checks[kind];
            const shownName = chosen[kind] ?? check?.name ?? null;
            return (
              <div key={kind} className={styles.fileRow}>
                <div className={styles.fileLabel}>
                  <label htmlFor={id}>{FILE_LABELS[kind].label}</label>
                  <span className={styles.fileHint} id={`${id}-hint`}>
                    {FILE_LABELS[kind].hint}
                  </span>
                </div>
                <div className={styles.filePick}>
                  <input
                    id={id}
                    name={kind}
                    type="file"
                    accept=".csv,text/csv"
                    className={styles.fileInput}
                    aria-describedby={`${id}-hint ${id}-check`}
                    onChange={onPick(kind)}
                    disabled={busy}
                  />
                  {shownName && !chosen[kind] && (
                    <span className={styles.fileName}>
                      <span className="visually-hidden">Last imported: </span>
                      {shownName}
                    </span>
                  )}
                </div>
                <div id={`${id}-check`} className={`${styles.fileCheck} ${check ? (check.ok ? '' : styles.fileCheckBad) : styles.fileCheckNone}`}>
                  {check ? (check.ok ? <CheckIcon /> : <CrossIcon />) : null}
                  <span>{check ? check.check : chosen[kind] ? 'Checked when you import' : 'No file yet'}</span>
                </div>
              </div>
            );
          })}

          <div className={styles.importActions}>
            <div className="field">
              <label htmlFor={`${uid}-run`}>Run date (count from this day)</label>
              <input
                id={`${uid}-run`}
                name="runDate"
                type="date"
                required
                defaultValue={defaultRunDate}
                className={`input ${styles.runDate}`}
                disabled={busy}
              />
            </div>
            <button type="submit" className="btn-primary" disabled={busy} aria-busy={busy}>
              {busy ? 'Importing…' : 'Import and analyse'}
            </button>
            <span id={`${uid}-status`} role="status" className={styles.busyText}>
              {busy ? 'Reading the notes and checking every opening. This can take a minute.' : (done ?? '')}
            </span>
          </div>

          <div role="alert" aria-live="assertive">
            {error && (
              <div className="alert alert-error">
                <CrossIcon />
                <span>{error}</span>
              </div>
            )}
          </div>
        </form>
      </section>

      <Summary view={view} uid={uid} />
    </main>
  );
}

function Summary({ view, uid }: { view: AdminView | null; uid: string }) {
  const headId = `${uid}-sum`;
  if (!view) {
    return (
      <section aria-labelledby={headId} className={styles.summary}>
        <h2 id={headId} style={{ fontSize: 21 }}>
          2 · What the notes say
        </h2>
        <div className={`card ${styles.empty}`}>
          Nothing imported yet. Choose the three files above and press <strong>Import and analyse</strong>.
        </div>
      </section>
    );
  }
  const c = view.counts;
  const imp = view.import;
  return (
    <section aria-labelledby={headId} className={styles.summary}>
      <h2 id={headId} style={{ fontSize: 21 }}>
        2 · What the notes say
      </h2>
      <p className={styles.meta}>
        <span>
          Run date <strong>{longDate(imp.runDate)}</strong>
        </span>
        <span>
          Booking export date <strong>{imp.bookingExportDate ? longDate(imp.bookingExportDate) : 'unknown'}</strong>{' '}
          (the latest booking in that file; &ldquo;booked since&rdquo; is only as current as this)
        </span>
        <span>Imported {timestampText(imp.createdAt)}</span>
      </p>

      {view.notReadWarning && (
        <div className="alert alert-warn">
          <WarnIcon />
          <span>{view.notReadWarning}</span>
        </div>
      )}

      <dl className={styles.tiles}>
        <div className={styles.tile}>
          <dt>Waitlist lines read</dt>
          <dd>{c.linesRead}</dd>
        </div>
        <div className={`${styles.tile} ${styles.tileAccent}`}>
          <dt>People ready to match</dt>
          <dd>{c.peopleReady}</dd>
        </div>
        <div className={styles.tile}>
          <dt>Repeat lines merged</dt>
          <dd>{c.repeatLinesMerged}</dd>
        </div>
        <div className={styles.tile}>
          <dt>Stale lines, never offered</dt>
          <dd>{c.staleLines}</dd>
        </div>
      </dl>

      <div className={`card ${styles.tableWrap}`} tabIndex={0} role="region" aria-label="People ready to match (scrolls sideways)">
        <table className={styles.table}>
          <caption>
            People ready to match. Grey text is the wording in the notes that each value came from. Showing{' '}
            {view.people.length === c.peopleReady ? `all ${c.peopleReady}` : `${view.people.length} of ${c.peopleReady}`}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col">Person</th>
              <th scope="col">Preferred therapist</th>
              <th scope="col">Length</th>
              <th scope="col">Availability</th>
              <th scope="col">Notice needed</th>
            </tr>
          </thead>
          <tbody>
            {view.people.map((p) => (
              <tr key={p.line}>
                <th scope="row" className={styles.lineCell} style={{ textAlign: 'left' }}>
                  {p.line}
                  {p.merged && <div className={styles.merged}>{p.merged}</div>}
                </th>
                <td>
                  <div className={styles.personName}>{p.name}</div>
                  <div className={styles.phone}>{p.phone}</div>
                </td>
                {[p.therapist, p.length, p.availability, p.notice].map((cell, i) => (
                  <td key={i}>
                    <div className={styles.value}>{cell.value}</div>
                    <div className={styles.source}>{cell.source}</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={`card ${styles.notOffered}`}>
        <h3>Not offered, and why</h3>
        {view.notOffered.length === 0 ? (
          <p className="muted">Everyone on the waitlist can be offered.</p>
        ) : (
          <ul>
            {view.notOffered.map((s) => (
              <li key={s.who}>
                <span className={styles.who}>{s.who}</span>
                <span className={styles.why}>{s.why}</span>
              </li>
            ))}
          </ul>
        )}
        <span className={styles.footnote}>
          {view.notOffered.length} {view.notOffered.length === 1 ? 'person' : 'people'} ({c.staleLines} stale lines). Everyone
          stays on file; nothing is deleted. Notes about health are never shown.
        </span>
        <a className="btn-link" href="/api/line-verdicts.csv" download>
          Download line_verdicts.csv
        </a>
      </div>
    </section>
  );
}
