'use client';
// The header on every screen (mockups Main / A3 / B5): clinic name, tool name and the four screens.
// The current screen is marked with aria-current and the teal tint. In Supabase mode the signed-in staff login and
// a Sign out button sit at the end (StaffSession renders nothing in local mode).
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { StaffSession } from '@/components/staff-session';

export const NAV_ITEMS = [
  { href: '/search', label: 'Search' },
  { href: '/today', label: "Today's openings" },
  { href: '/week', label: 'Week schedule' },
  { href: '/admin', label: 'Waitlist (admin)' },
] as const;

export function AppHeader() {
  const pathname = usePathname() ?? '';
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-name">Kettle &amp; Stone</span>
        <span className="brand-sub">Waitlist shortlist</span>
      </div>
      <nav aria-label="Screens" className="app-nav">
        <ul>
          {NAV_ITEMS.map((item) => {
            const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={current ? 'page' : undefined}>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <StaffSession />
    </header>
  );
}
