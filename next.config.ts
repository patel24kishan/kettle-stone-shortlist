import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The clinic time zone (src/lib/clinic.ts). Built into the server and the browser code, so every screen shows
  // the same day and clock. Empty = America/Moncton. Changing it needs a restart of `npm run dev` or a new build.
  env: {
    CLINIC_TIME_ZONE: process.env.CLINIC_TIME_ZONE ?? '',
  },
  // The saved sample readings are read from disk at run time (src/lib/cache-setup.ts, src/lib/storage/*), so the
  // build cannot see them. Ship them with every server function on Vercel (route globs; paths from the project root).
  outputFileTracingIncludes: {
    '/*': ['./data/sample/readings.json'],
    '/api/**/*': ['./data/sample/readings.json'],
  },
};

export default nextConfig;
