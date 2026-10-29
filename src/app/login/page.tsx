// Staff login (feature 6e; build-plan section 4: "Supabase Auth for the staff login"). Only used in Supabase mode;
// the proxy sends signed-out visits here. In local mode there is no login (BUILD_PROGRESS A3), so this page just
// says so.
import Link from 'next/link';
import { connection } from 'next/server';
import { storeKind } from '@/lib/storage';
import { supabasePublicEnv } from '@/lib/supabase/env';
import { safeNext } from '@/lib/supabase/paths';
import { LoginForm } from './login-form';
import styles from './login.module.css';

export const metadata = { title: 'Sign in · Kettle & Stone' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection(); // the mode is read at request time, never at build time
  const params = await searchParams;
  const nextParam = Array.isArray(params.next) ? params.next[0] : params.next;
  const local = storeKind() !== 'supabase';

  return (
    <main className={`page ${styles.page}`}>
      <section className={`card card-pad ${styles.card}`} aria-labelledby="login-h">
        <div className="section-head">
          <h1 id="login-h" className={styles.title}>
            Staff sign in
          </h1>
          {local ? (
            <p>This copy runs on the local store, so there is no staff login.</p>
          ) : (
            <p>Sign in with your clinic staff email and password.</p>
          )}
        </div>
        {local ? (
          <Link className="btn-link" href="/search">
            Go to Search
          </Link>
        ) : (
          <LoginForm next={safeNext(nextParam)} configured={supabasePublicEnv() !== null} />
        )}
      </section>
    </main>
  );
}
