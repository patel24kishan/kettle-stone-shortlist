// Realtime for the live-version hook (src/lib/live/realtime.ts, feature 6e). The browser client is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rt = vi.hoisted(() => ({
  created: 0,
  handler: null as null | (() => void),
  status: null as null | ((s: string) => void),
  filter: null as unknown,
  removed: 0,
}));

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: () => {
    rt.created++;
    const channel = {
      on(_type: string, filter: unknown, cb: () => void) {
        rt.filter = filter;
        rt.handler = cb;
        return channel;
      },
      subscribe(cb: (s: string) => void) {
        rt.status = cb;
        return channel;
      },
    };
    return {
      channel: () => channel,
      removeChannel: async () => {
        rt.removed++;
        return 'ok';
      },
    };
  },
}));

const { subscribeToChanges } = await import('@/lib/live/realtime');

const NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  Object.assign(rt, { created: 0, handler: null, status: null, filter: null, removed: 0 });
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('subscribeToChanges', () => {
  it('does nothing in local mode (no Supabase client is made)', async () => {
    const onChange = vi.fn();
    const stop = subscribeToChanges(onChange);
    await flush();
    stop();
    expect(rt.created).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('with Supabase configured, listens to app_state and calls onChange on every change and on (re)connect', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example-project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-not-real';
    const onChange = vi.fn();
    const stop = subscribeToChanges(onChange);
    await flush();
    expect(rt.created).toBe(1);
    expect(rt.filter).toEqual({ event: '*', schema: 'public', table: 'app_state' });
    rt.status!('SUBSCRIBED');
    expect(onChange).toHaveBeenCalledTimes(1);
    rt.handler!();
    rt.handler!();
    expect(onChange).toHaveBeenCalledTimes(3);
    rt.status!('CHANNEL_ERROR');
    expect(onChange).toHaveBeenCalledTimes(3);
    stop();
    expect(rt.removed).toBe(1);
  });

  it('stopping before the client loads never subscribes', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example-project.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-not-real';
    const stop = subscribeToChanges(vi.fn());
    stop();
    await flush();
    expect(rt.handler).toBeNull();
  });
});
