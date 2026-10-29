// Realtime (feature 6e, build-plan section 4: "Other open screens update by themselves ... through Supabase
// Realtime within a few seconds"). When Supabase is configured, the browser listens to the app_state row; every
// import, Booked and undo bumps its version (a database trigger), and each change calls `onChange` (the version
// watcher's checkNow, which then fetches /api/state as usual). Polling stays on as the fallback.
// In local mode this does nothing and loads nothing.
import { browserSupabase, publicSupabaseConfig } from '@/lib/supabase/browser';

/** Starts listening; returns the function that stops. Never throws: if Realtime fails, polling still works. */
export function subscribeToChanges(onChange: () => void): () => void {
  if (!publicSupabaseConfig()) return () => {};
  let stopped = false;
  let stop = () => {};
  void browserSupabase()
    .then((supabase) => {
      if (!supabase || stopped) return;
      const channel = supabase
        .channel(`app-state-${Math.random().toString(36).slice(2, 10)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state' }, () => onChange())
        // (Re)connected: check once, in case something changed while the connection was down.
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') onChange();
        });
      stop = () => {
        void supabase.removeChannel(channel).catch(() => undefined);
      };
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop();
  };
}
