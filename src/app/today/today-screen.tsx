'use client';
// Screen 3 "Today's openings" (reference/mockups/A3-Todays-openings.dc.html): every late opening on one date,
// each with up to 3 names and a Booked button.
// Booked (build-plan section 4) works exactly as on the Search screen: save first, then show; a failed save says
// so and leaves the card as it was; a second booking of an opening is refused ("Already filled by ..."); after
// each save the day is fetched again, so a person booked for one opening leaves every other opening.
// Other open screens and tabs update by themselves (useLiveVersion). rules.md "Always": only name, phone, line
// number and the opening are shown; never notes or health details.
import Link from 'next/link';
import { useCallback, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { announceChange } from '@/lib/live/channel';
import { useLiveVersion } from '@/lib/live/use-live-version';
import { JOSEE_NOTE, SHORT_LINE, alreadyFilledText, bookingExportText, filledView } from '@/lib/search-view';
import type { SearchCard } from '@/lib/search-view';
import type { TodayResult } from '@/lib/server/today-service';
import { TODAY_FOOTER, datesHint, goToText, noOpeningsText, todaySubtitle, todayTitle } from '@/lib/today-view';
import type { TodayOpeningView } from '@/lib/today-view';
import type { BookedRecord } from '@/lib/types';
import searchStyles from '../search/search.module.css';
import styles from './today.module.css';

type TodayOk = Extract<TodayResult, { ok: true }>;
type Note = { kind: 'error' | 'info'; text: string };

const NETWORK_ERROR = 'Could not reach the server. Check the tool is running and try again.';
const lineNumber = (lineId: string) => Number(lineId.replace(/\D/g, '')) || lineId;

function CheckIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

function NobodyIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#374151" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21" />
      <path d="M7.5 10.5h6" />
    </svg>
  );
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

export interface TodayScreenProps {
  /** YYYY-MM-DD, the clinic's today. */
  today: string;
  /** Today's openings, loaded on the server. */
  initial: TodayResult;
}

export function TodayScreen({ today, initial }: TodayScreenProps) {
  const uid = useId();
  const [date, setDate] = useState(today);
  const [data, setData] = useState<TodayOk | null>(initial.ok ? initial : null);
  const [noImport, setNoImport] = useState(!initial.ok && initial.noImport === true);
  const [error, setError] = useState<string | null>(initial.ok || initial.noImport ? null : initial.message);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const latest = useRef(0);

  /** Fetches one day. `quiet` = a refresh (after Booked / Undo or a change elsewhere): the current view stays if it fails. */
  const load = useCallback(async (forDate: string, quiet = false): Promise<boolean> => {
    const mine = ++latest.current;
    const fail = (message: string) => {
      if (quiet) {
        setRefreshError(`Could not refresh the list: ${message}`);
      } else {
        setError(message);
        setData(null);
      }
    };
    try {
      const res = await fetch(`/api/today?date=${encodeURIComponent(forDate)}`, { cache: 'no-store' });
      const body = await readJson<TodayResult>(res);
      if (mine !== latest.current) return false; // a newer request is on its way
      if (body && body.ok) {
        setData(body);
        setNoImport(false);
        setError(null);
        setRefreshError(null);
        return true;
      }
      if (body && !body.ok && body.noImport) {
        setNoImport(true);
        setData(null);
        setError(null);
        return false;
      }
      fail(body && !body.ok ? body.message : `The list did not load (server answered ${res.status}).`);
      return false;
    } catch {
      if (mine === latest.current) fail(NETWORK_ERROR);
      return false;
    }
  }, []);

  // Live sync: another tab or device booked, undid or imported something.
  useLiveVersion({
    onChange: () => void load(date, true),
    initialVersion: initial.ok ? initial.context.version : null,
    knownVersion: data?.context.version ?? null,
  });

  function onDate(e: ChangeEvent<HTMLInputElement>) {
    const next = e.currentTarget.value;
    setDate(next);
    if (!next) return;
    setNotes({});
    setRefreshError(null);
    void load(next);
  }

  function goTo(iso: string) {
    setDate(iso);
    setNotes({});
    setRefreshError(null);
    void load(iso);
  }

  const setNote = (id: string, note: Note | null) =>
    setNotes((n) => {
      const next = { ...n };
      if (note) next[id] = note;
      else delete next[id];
      return next;
    });

  /** The opening is filled: shown at once from the saved record, before the refresh comes back. */
  function showFilled(openingId: string, record: BookedRecord) {
    setData((d) =>
      d
        ? {
            ...d,
            openings: d.openings.map((o) =>
              o.id === openingId ? { ...o, fitLabel: 'Filled', cards: [], short: false, nobody: null, filled: filledView(record) } : o,
            ),
          }
        : d,
    );
  }

  async function book(opening: TodayOpeningView, card: SearchCard) {
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
        await load(date, true);
      } else if (res.status === 409 && body && !body.ok && body.existing) {
        setNote(opening.id, { kind: 'error', text: alreadyFilledText(body.existing) });
        await load(date, true);
      } else {
        const why = body && !body.ok ? body.message : `The server answered ${res.status}.`;
        setNote(opening.id, { kind: 'error', text: `Not saved: ${why}` });
        if (body && !body.ok && body.noImport) setNoImport(true);
      }
    } catch {
      setNote(opening.id, { kind: 'error', text: `Not saved. ${NETWORK_ERROR}` });
    } finally {
      setSaving(null);
    }
  }

  async function undo(opening: TodayOpeningView) {
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
      await load(date, true);
    } catch {
      setNote(opening.id, { kind: 'error', text: `Not undone. ${NETWORK_ERROR}` });
    } finally {
      setSaving(null);
    }
  }

  if (noImport) {
    return (
      <main className="page">
        <section className="card card-pad" aria-labelledby={`${uid}-none`}>
          <h1 id={`${uid}-none`} className={styles.title}>
            Today&apos;s late openings
          </h1>
          <p className={styles.noImport}>
            Nothing imported yet. Import the waitlist, the late openings and the booking export in{' '}
            <Link href="/admin">Waitlist (admin)</Link> first; this screen shows the late openings of that import.
          </p>
        </section>
      </main>
    );
  }

  const hint = data ? datesHint(data.dates) : null;

  return (
    <main className="page">
      <div className={styles.head}>
        <h1 className={styles.title}>Today&apos;s late openings</h1>
        {data && <span className={styles.subtitle}>{todaySubtitle(data.dateLabel, data.count)}</span>}
      </div>

      <div className={styles.dateRow}>
        <div className="field">
          <label htmlFor={`${uid}-date`}>Date</label>
          <input id={`${uid}-date`} type="date" value={date} onChange={onDate} className={styles.dateInput} />
        </div>
        {data && <p className={styles.meta}>{bookingExportText(data.context.bookingExportDate)}</p>}
      </div>

      <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {error && (
          <div className="alert alert-error" role="alert">
            <CrossIcon />
            <span>{error}</span>
          </div>
        )}
        {refreshError && (
          <div className="alert alert-error" role="alert">
            <CrossIcon />
            <span>{refreshError}</span>
          </div>
        )}
      </div>

      {data && data.count === 0 && (
        <section className={`card ${styles.empty}`} aria-labelledby={`${uid}-empty`}>
          <h2 id={`${uid}-empty`} className={styles.emptyHead}>
            {noOpeningsText(data.dateLabel)}
          </h2>
          {hint && <p className={styles.emptyHint}>{hint}</p>}
          {data.dates.last && (
            <div className={styles.links}>
              {data.dates.last !== data.date && (
                <button type="button" className={styles.link} onClick={() => goTo(data.dates.last!)}>
                  {goToText(data.dates.last)}
                </button>
              )}
              {data.dates.first && data.dates.first !== data.date && data.dates.first !== data.dates.last && (
                <button type="button" className={styles.link} onClick={() => goTo(data.dates.first!)}>
                  {goToText(data.dates.first)}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {data && data.count > 0 && (
        <>
          <ul className={styles.grid} aria-label="Late openings">
            {data.openings.map((o) => (
              <li key={o.id} className={styles.opening}>
                <OpeningCard uid={uid} opening={o} saving={saving} note={notes[o.id]} onBook={book} onUndo={undo} />
              </li>
            ))}
          </ul>
          <p className={styles.footer}>{TODAY_FOOTER}</p>
        </>
      )}
    </main>
  );
}

interface CardProps {
  uid: string;
  opening: TodayOpeningView;
  saving: string | null;
  note: Note | undefined;
  onBook: (o: TodayOpeningView, c: SearchCard) => void;
  onUndo: (o: TodayOpeningView) => void;
}

function OpeningCard({ uid, opening: o, saving, note, onBook, onUndo }: CardProps) {
  const headId = `${uid}-o-${o.id}`;
  return (
    <article aria-labelledby={headId}>
      <div className={styles.openingHead}>
        <h2 id={headId} className={styles.openingTitle}>
          {todayTitle(o)}
        </h2>
        <span className={styles.length}>{o.lengthMin} min</span>
      </div>

      <div className={styles.extras}>
        {o.joseeNote && <p className={searchStyles.josee}>{JOSEE_NOTE}</p>}
        {note &&
          (note.kind === 'error' ? (
            <div className="alert alert-error" role="alert">
              <CrossIcon />
              <span>{note.text}</span>
            </div>
          ) : (
            <p className={searchStyles.saved} role="status">
              <CheckIcon color="#047857" size={20} />
              {note.text}
            </p>
          ))}
      </div>

      {o.filled ? (
        <div className={styles.filledWrap}>
          <div className={searchStyles.filled}>
            <span className={searchStyles.filledIcon}>
              <CheckIcon color="#FFFFFF" size={20} />
            </span>
            <div className={searchStyles.filledText}>
              <p className={searchStyles.filledHead}>Booked: {o.filled.name}</p>
              <p className={searchStyles.filledSub}>
                Waitlist line {lineNumber(o.filled.lineId)} · marked {o.filled.atText}. This opening is filled.
              </p>
            </div>
            <button
              type="button"
              className={searchStyles.secondary}
              onClick={() => onUndo(o)}
              disabled={saving !== null}
              aria-busy={saving === `undo:${o.id}`}
              aria-label={`Undo: ${o.filled.name} is not booked for this opening`}
            >
              {saving === `undo:${o.id}` ? 'Undoing…' : 'Undo'}
            </button>
          </div>
        </div>
      ) : o.cards.length > 0 ? (
        <div className={styles.body}>
          <ol className={styles.people} aria-label="People to call, in waitlist order">
            {o.cards.map((c) => (
              <li key={c.lineId} className={styles.person}>
                <div className={styles.who}>
                  <span className={styles.name}>{c.name}</span>
                  <a href={c.tel} className={styles.phone} aria-label={`Call ${c.name}, ${c.phone}`}>
                    {c.phone}
                  </a>
                </div>
                <button
                  type="button"
                  className={styles.booked}
                  onClick={() => onBook(o, c)}
                  disabled={saving !== null}
                  aria-busy={saving === `${o.id}:${c.lineId}`}
                  aria-label={`Booked: ${c.name} said yes and is booked in Kneadly`}
                >
                  <CheckIcon />
                  {saving === `${o.id}:${c.lineId}` ? 'Saving…' : 'Booked'}
                </button>
              </li>
            ))}
          </ol>
          {o.short && <p className={styles.short}>{SHORT_LINE}</p>}
        </div>
      ) : o.nobody ? (
        <div className={styles.nobodyWrap}>
          <div className={searchStyles.nobody}>
            <NobodyIcon />
            <div className={searchStyles.nobodyText}>
              <p className={searchStyles.nobodyHead}>{o.nobody.head}</p>
              <p className={searchStyles.nobodyWhy}>{o.nobody.why}</p>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
