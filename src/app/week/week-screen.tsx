'use client';
// Screen 4 "Week schedule" (reference/mockups/A4-Week-schedule.dc.html): day tabs, a legend and one column per
// therapist working that day, hourly rows 9 AM to 8 PM. SIMULATED DATA ONLY (BUILD_PROGRESS assumption A5): it
// reads no export, store or API and does not connect to Kneadly. Every block says its status in words, not only
// colour; no notes or health details (rules.md "Always").
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  GRID_HEIGHT,
  LEGEND_STATUSES,
  STATUS_LOOK,
  blockFor,
  columnsFor,
  daySummary,
  hourLabels,
  rowsForColumn,
} from '@/lib/week/layout';
import { DEFAULT_DAY, SAMPLE_WEEK, WEEK_DAYS, WEEK_TITLE } from '@/lib/week/sample-week';
import styles from './week.module.css';

const SAMPLE_NOTE = 'Sample data: a made-up week to show the layout. It does not read the booking export or Kneadly.';
const HOURS = hourLabels();

export function WeekScreen() {
  const [day, setDay] = useState(DEFAULT_DAY);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const columns = columnsFor(day, SAMPLE_WEEK);
  const dayRows = SAMPLE_WEEK.filter((r) => r.day === day);

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = WEEK_DAYS.length - 1;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next < 0) return;
    e.preventDefault();
    setDay(WEEK_DAYS[next].iso);
    tabRefs.current[next]?.focus();
  }

  return (
    <main className="page">
      <div className={styles.head}>
        <h1 className={styles.title}>{WEEK_TITLE}</h1>
        <span className={styles.summary} aria-live="polite">
          {daySummary(dayRows)}
        </span>
      </div>

      <div role="tablist" aria-label="Day" className={styles.tabs}>
        {WEEK_DAYS.map((d, i) => {
          const on = d.iso === day;
          return (
            <button
              key={d.iso}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`week-tab-${d.iso}`}
              aria-selected={on}
              aria-controls="week-panel"
              tabIndex={on ? 0 : -1}
              className={`${styles.tab} ${on ? styles.tabOn : ''}`}
              onClick={() => setDay(d.iso)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {d.tab}
            </button>
          );
        })}
      </div>

      <ul aria-label="Legend" className={styles.legend}>
        {LEGEND_STATUSES.map((s) => {
          const look = STATUS_LOOK[s];
          return (
            <li key={s}>
              <span className={styles.swatch} style={{ background: look.background, border: look.border }} aria-hidden="true" />
              {look.legend}
            </li>
          );
        })}
      </ul>

      <div className={styles.card} role="tabpanel" id="week-panel" aria-labelledby={`week-tab-${day}`}>
        <div
          className={styles.grid}
          style={{
            gridTemplateColumns: `84px repeat(${columns.length}, minmax(0, 1fr))`,
            minWidth: Math.max(900, 84 + columns.length * 170),
          }}
        >
          <div className={styles.corner} />
          {columns.map((name) => (
            <div key={name} className={styles.colHead}>
              {name}
            </div>
          ))}
          <div className={styles.hours} style={{ height: GRID_HEIGHT }}>
            {HOURS.map((h) => (
              <span key={h.label} className={styles.hour} style={{ top: h.top }}>
                {h.label}
              </span>
            ))}
          </div>
          {columns.map((name) => (
            <div key={name} className={styles.col} style={{ height: GRID_HEIGHT }}>
              {rowsForColumn(day, name, SAMPLE_WEEK).map((row) => {
                const b = blockFor(row);
                return (
                  <div
                    key={`${row.start}-${row.client}`}
                    className={styles.block}
                    style={{ top: b.top, height: b.height, background: b.style.background, border: b.style.border }}
                  >
                    <div className={styles.client} style={{ color: b.style.ink }}>
                      {row.client}
                    </div>
                    <div className={styles.when} style={{ color: b.style.meta }}>
                      {b.label}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <p className={styles.note}>{SAMPLE_NOTE}</p>
    </main>
  );
}
