'use client';
// "Signed in as … · Sign out" in the header (feature 6e). Shown only when Supabase is configured and a staff
// member is signed in; renders nothing in local mode (no login there, BUILD_PROGRESS A3).
// The email shown here is for display only; the proxy checks the session on every request.
import { useEffect, useState } from 'react';
import { browserSupabase, publicSupabaseConfig } from '@/lib/supabase/browser';
import { LOGIN_PATH } from '@/lib/supabase/paths';

export function StaffSession() {
  const [login, setLogin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicSupabaseConfig()) return;
    let cancelled = false;
    let unsubscribe = () => {};
    void browserSupabase()
      .then(async (supabase) => {
        if (!supabase || cancelled) return;
        const { data } = await supabase.auth.getSession();
        if (!cancelled) setLogin(data.session ? (data.session.user.email ?? 'staff') : null);
        const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
          setLogin(session ? (session.user.email ?? 'staff') : null);
        });
        unsubscribe = () => sub.subscription.unsubscribe();
        if (cancelled) unsubscribe();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!login) return null;

  async function signOut() {
    setBusy(true);
    setError(null);
    try {
      const supabase = await browserSupabase();
      // This device only: Tanya signing out at the desk does not sign out Bethany's phone.
      const res = await supabase?.auth.signOut({ scope: 'local' });
      if (res?.error) throw res.error;
      window.location.assign(LOGIN_PATH);
    } catch {
      setBusy(false);
      setError('Could not sign out. Try again.');
    }
  }

  return (
    <div className="staff-session">
      <span className="staff-session-name">
        Signed in as <strong>{login}</strong>
      </span>
      <button type="button" className="btn-secondary" onClick={signOut} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {error ? (
        <span role="alert" className="staff-session-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
