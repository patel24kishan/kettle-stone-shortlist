// Screen 1 "Search" (reference/mockups/A1b-Search-one-or-all.dc.html; A1 = Main.dc.html, A2 / A2b = nobody).
// The waitlist it matches against is loaded on the server so the page opens with it; the client component does
// the searches and the Booked button through /api/search, /api/search/file and /api/booked.
import { connection } from 'next/server';
import { todayIso } from '@/lib/format';
import { getStore } from '@/lib/storage';
import { getSearchContext } from '@/lib/server/search-service';
import { clinicNowLocal } from '@/lib/search-view';
import { SearchScreen } from './search-screen';

export const metadata = { title: 'Search · Kettle & Stone' };

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection(); // reads the store on every request, never at build time
  const params = await searchParams;
  const context = await getSearchContext(getStore());
  return (
    <SearchScreen
      initialContext={context}
      initialMode={params.mode === 'file' ? 'file' : 'one'}
      today={todayIso()}
      nowLocal={clinicNowLocal()}
    />
  );
}
