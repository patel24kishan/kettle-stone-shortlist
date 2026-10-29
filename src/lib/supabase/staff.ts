// Which staff login made a request (feature 6e, build-plan section 4: a Booked row records "which staff login did
// it"). The proxy checks the Supabase session and passes the login to the route in this request header; it always
// removes any copy the browser sent, so the value can only come from the proxy. Routes read it only in Supabase
// mode (in local mode there is no proxy check and no login, and bookings say "local").
export const STAFF_HEADER = 'x-shortlist-staff-login';

/** The staff login the proxy passed on, or undefined when there is none. */
export function staffLoginFrom(headers: Headers): string | undefined {
  const raw = headers.get(STAFF_HEADER);
  if (!raw) return undefined;
  try {
    const login = decodeURIComponent(raw).trim();
    return login ? login.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
