// Screen 3 "Today's openings" (reference/mockups/A3-Todays-openings.dc.html). Today's openings are loaded on the
// server so the page opens with them; the client component handles the date, Booked / Undo and live updates.
import { connection } from 'next/server';
import { todayIso } from '@/lib/format';
import { getStore } from '@/lib/storage';
import { todayOpenings } from '@/lib/server/today-service';
import { TodayScreen } from './today-screen';

export const metadata = { title: "Today's openings · Kettle & Stone" };

export default async function TodayPage() {
  await connection(); // reads the store on every request, never at build time
  const today = todayIso();
  const initial = await todayOpenings(getStore(), today);
  return <TodayScreen today={today} initial={initial} />;
}
