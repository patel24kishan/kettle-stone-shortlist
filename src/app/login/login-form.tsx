'use client';
// The email + password form (feature 6e). Supabase Auth through the @supabase/ssr browser client, which keeps the
// session in a cookie the proxy can read. Errors are plain words; the password never leaves this form except to
// Supabase.
import { useState } from 'react';
import type { FormEvent } from 'react';
import { browserSupabase } from '@/lib/supabase/browser';

function errorText(code: string | undefined, status: number | undefined): string {
  if (code === 'invalid_credentials' || status === 400) return 'That email and password do not match a staff login.';
  if (code === 'email_not_confirmed') return 'This email has not been confirmed yet. Ask whoever set up the logins.';
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) {
    return 'Too many tries. Wait a minute and try again.';
  }
  return 'Could not sign in right now. Check the connection and try again.';
}

export function LoginForm({ next, configured }: { next: string; configured: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    configured ? null : 'Staff login is not set up yet: NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.',
  );

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const supabase = await browserSupabase();
      if (!supabase) throw new Error('not configured');
      const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (authError) {
        setError(errorText(authError.code, authError.status));
        setBusy(false);
        return;
      }
      // A full page load, so the proxy sees the new session cookie.
      window.location.assign(next);
    } catch {
      setError('Could not reach the login service. Check the connection and try again.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="field">
        <label htmlFor="login-email">Email</label>
        <input
          id="login-email"
          className="input"
          type="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy || !configured}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy || !configured}
          required
        />
      </div>
      {error ? (
        <p className="alert alert-error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn-primary" disabled={busy || !configured}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
