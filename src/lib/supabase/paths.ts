// Paths the staff login gate treats specially (feature 6e). Shared by the proxy and the login page; no server code.
export const LOGIN_PATH = '/login';

const STATIC_FILE = /\.(?:css|js|mjs|map|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|txt|webmanifest)$/i;

/** Next's own files and plain static files: never behind the login (the login page needs them too). */
export function isStaticAsset(pathname: string): boolean {
  return pathname.startsWith('/_next/') || pathname === '/favicon.ico' || STATIC_FILE.test(pathname);
}

export const isApiPath = (pathname: string): boolean => pathname === '/api' || pathname.startsWith('/api/');
export const isLoginPath = (pathname: string): boolean => pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`);

/** A same-site path to go back to after signing in; anything else becomes "/". */
export function safeNext(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || isLoginPath(v.split('?')[0]!)) return '/';
  return v;
}
