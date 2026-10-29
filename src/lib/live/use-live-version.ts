'use client';
// React wrapper around createVersionWatcher: polls /api/state, listens on the BroadcastChannel and calls
// `onChange` when the saved records changed (a Booked, an Undo or an import, here or in another tab).
// With Supabase configured it also listens to Realtime (feature 6e) and checks at once on every change.
import { useEffect, useRef } from 'react';
import { openChannel } from './channel';
import { subscribeToChanges } from './realtime';
import { createVersionWatcher } from './version-watcher';
import type { Version, VersionWatcher } from './version-watcher';

export interface LiveVersionOptions {
  /** Called when the version changed: fetch the screen's data again. The latest function is always used. */
  onChange: () => void;
  /** The version the screen was loaded with, if it has one. Without it the first check is the baseline. */
  initialVersion?: number | null;
  /** The version of the data the screen shows right now, so its own refetch is not reported as a change. */
  knownVersion?: number | null;
  /** Turn watching off (for example before anything is imported). Default on. */
  enabled?: boolean;
  intervalMs?: number;
}

async function fetchStateVersion(): Promise<Version> {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== 'number') throw new Error('no version');
  return body.version;
}

export function useLiveVersion({ onChange, initialVersion, knownVersion, enabled = true, intervalMs }: LiveVersionOptions): void {
  const onChangeRef = useRef(onChange);
  const initialRef = useRef(initialVersion ?? null);
  const watcherRef = useRef<VersionWatcher | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled) return;
    const channel = openChannel();
    const watcher = createVersionWatcher({
      fetchVersion: fetchStateVersion,
      onChange: () => onChangeRef.current(),
      intervalMs,
      initialVersion: initialRef.current,
      isHidden: () => document.visibilityState === 'hidden',
      subscribeVisibility: (callback) => {
        document.addEventListener('visibilitychange', callback);
        return () => document.removeEventListener('visibilitychange', callback);
      },
      channel,
    });
    watcherRef.current = watcher;
    const stopRealtime = subscribeToChanges(() => void watcher.checkNow());
    return () => {
      stopRealtime();
      watcher.stop();
      watcherRef.current = null;
      channel?.close();
    };
  }, [enabled, intervalMs]);

  useEffect(() => {
    watcherRef.current?.acknowledge(knownVersion);
  }, [knownVersion, enabled]);
}
