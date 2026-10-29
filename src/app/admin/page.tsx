// B5 "Waitlist (admin)": import the clinic's files and see what the notes say. The latest import is loaded
// on the server so the page opens with it; the client component handles new imports.
import { connection } from 'next/server';
import { todayIso } from '@/lib/format';
import { getStore } from '@/lib/storage';
import { getAdminView } from '@/lib/server/queries';
import { AdminScreen } from './admin-screen';

export const metadata = { title: 'Waitlist (admin) · Kettle & Stone' };

export default async function AdminPage() {
  await connection(); // reads the store on every request, never at build time
  const store = getStore();
  const version = await store.version(); // read first: if anything changes meanwhile, live sync reloads the view
  const data = await getAdminView(store);
  return <AdminScreen initial={'empty' in data ? null : data} defaultRunDate={todayIso()} initialVersion={version} />;
}
