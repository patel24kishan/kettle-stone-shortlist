// The live-sync watcher (build-plan section 4, "Other open screens update by themselves ... within a few
// seconds"): fake timers, a fake channel and a fake page-visibility switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVersionWatcher } from '@/lib/live/version-watcher';
import type { VersionWatcher, VersionWatcherOptions, WatcherChannel } from '@/lib/live/version-watcher';

class FakeChannel implements WatcherChannel {
  listeners = new Set<() => void>();
  addEventListener(_type: 'message', listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: () => void) {
    this.listeners.delete(listener);
  }
  emit() {
    for (const l of [...this.listeners]) l();
  }
}

/** A page whose visibility the test flips. */
function fakePage() {
  const callbacks = new Set<() => void>();
  const page = {
    hidden: false,
    isHidden: () => page.hidden,
    subscribeVisibility: (cb: () => void) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    set(hidden: boolean) {
      page.hidden = hidden;
      for (const cb of [...callbacks]) cb();
    },
    subscribers: () => callbacks.size,
  };
  return page;
}

let server: { version: number; calls: number; fail: boolean };
let changes: Array<number | string>;
let channel: FakeChannel;
let page: ReturnType<typeof fakePage>;
let watcher: VersionWatcher | null;

function start(extra: Partial<VersionWatcherOptions> = {}) {
  watcher = createVersionWatcher({
    fetchVersion: async () => {
      server.calls += 1;
      if (server.fail) throw new Error('offline');
      return server.version;
    },
    onChange: (v) => changes.push(v),
    isHidden: page.isHidden,
    subscribeVisibility: page.subscribeVisibility,
    channel,
    ...extra,
  });
  return watcher;
}

beforeEach(() => {
  vi.useFakeTimers();
  server = { version: 1, calls: 0, fail: false };
  changes = [];
  channel = new FakeChannel();
  page = fakePage();
  watcher = null;
});
afterEach(() => {
  watcher?.stop();
  vi.useRealTimers();
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('createVersionWatcher', () => {
  it('checks right away and treats the first answer as the baseline (no change reported)', async () => {
    start();
    await tick(0);
    expect(server.calls).toBe(1);
    expect(changes).toEqual([]);
  });

  it('fires onChange once per version change and not on equal versions', async () => {
    start();
    await tick(0);
    await tick(3000);
    await tick(3000);
    expect(changes).toEqual([]); // 1, 1, 1
    server.version = 2;
    await tick(3000);
    expect(changes).toEqual([2]);
    await tick(3000);
    await tick(3000);
    expect(changes).toEqual([2]); // still 2: nothing new
    server.version = 3;
    await tick(3000);
    expect(changes).toEqual([2, 3]);
  });

  it('polls every 3 seconds by default and honours intervalMs', async () => {
    start();
    await tick(0);
    expect(server.calls).toBe(1);
    await tick(2999);
    expect(server.calls).toBe(1);
    await tick(1);
    expect(server.calls).toBe(2);

    watcher!.stop();
    server.calls = 0;
    start({ intervalMs: 500 });
    await tick(0);
    await tick(1500);
    expect(server.calls).toBe(4);
  });

  it('reports a change made while the page was loading when it knows the version it loaded with', async () => {
    server.version = 5;
    start({ initialVersion: 4 });
    await tick(0);
    expect(changes).toEqual([5]);
  });

  it('does not report a version the screen already shows (acknowledge)', async () => {
    start();
    await tick(0);
    server.version = 2;
    watcher!.acknowledge(2); // the screen refetched its own data and now shows version 2
    await tick(3000);
    expect(changes).toEqual([]);
    server.version = 3;
    await tick(3000);
    expect(changes).toEqual([3]);
  });

  it('does not poll while the page is hidden', async () => {
    start();
    await tick(0);
    page.set(true);
    const before = server.calls;
    server.version = 2;
    await tick(30_000);
    expect(server.calls).toBe(before);
    expect(changes).toEqual([]);
  });

  it('checks immediately when the page becomes visible again', async () => {
    start();
    await tick(0);
    page.set(true);
    server.version = 2;
    await tick(10_000);
    expect(changes).toEqual([]);
    const before = server.calls;
    page.set(false); // visible again: no waiting for the next 3 s tick
    await tick(0);
    expect(server.calls).toBe(before + 1);
    expect(changes).toEqual([2]);
  });

  it('going hidden does not trigger a check', async () => {
    start();
    await tick(0);
    const before = server.calls;
    page.set(true);
    await tick(0);
    expect(server.calls).toBe(before);
  });

  it('a channel message triggers a check at once', async () => {
    start();
    await tick(0);
    const before = server.calls;
    server.version = 2;
    channel.emit();
    await tick(0);
    expect(server.calls).toBe(before + 1);
    expect(changes).toEqual([2]);
  });

  it('a channel message while hidden waits for the page to be shown', async () => {
    start();
    await tick(0);
    page.set(true);
    const before = server.calls;
    server.version = 2;
    channel.emit();
    await tick(0);
    expect(server.calls).toBe(before);
    page.set(false);
    await tick(0);
    expect(changes).toEqual([2]);
  });

  it('keeps going after a fetch error and reports the change when the server is back', async () => {
    start();
    await tick(0);
    server.fail = true;
    await tick(3000);
    await tick(3000);
    expect(changes).toEqual([]);
    const during = server.calls;
    expect(during).toBeGreaterThanOrEqual(3);
    server.fail = false;
    server.version = 2;
    await tick(3000);
    expect(changes).toEqual([2]);
  });

  it('keeps going when onChange throws', async () => {
    const seen: number[] = [];
    start({
      onChange: (v) => {
        seen.push(Number(v));
        throw new Error('screen bug');
      },
    });
    await tick(0);
    server.version = 2;
    await tick(3000);
    server.version = 3;
    await tick(3000);
    expect(seen).toEqual([2, 3]);
  });

  it('does not stack checks: a slow answer is awaited, not repeated', async () => {
    let release: (v: number) => void = () => {};
    let calls = 0;
    watcher = createVersionWatcher({
      fetchVersion: () => {
        calls += 1;
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
      onChange: (v) => changes.push(v),
      channel,
    });
    await tick(10_000);
    expect(calls).toBe(1);
    release(7);
    await tick(0);
    await tick(3000);
    expect(calls).toBe(2);
  });

  it('stop() ends polling, channel and visibility listening, and ignores an answer still on its way', async () => {
    let release: (v: number) => void = () => {};
    let calls = 0;
    let slow = false;
    const w = createVersionWatcher({
      fetchVersion: () => {
        calls += 1;
        if (!slow) return Promise.resolve(1);
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
      onChange: (v) => changes.push(v),
      isHidden: page.isHidden,
      subscribeVisibility: page.subscribeVisibility,
      channel,
    });
    await tick(0);
    slow = true;
    await tick(3000); // a check is now in flight
    expect(channel.listeners.size).toBe(1);
    expect(page.subscribers()).toBe(1);

    w.stop();
    w.stop(); // twice is fine
    expect(channel.listeners.size).toBe(0);
    expect(page.subscribers()).toBe(0);

    release(9); // the answer arrives after stop(): nobody is told
    await tick(0);
    const before = calls;
    await tick(60_000);
    channel.emit();
    page.set(true);
    page.set(false);
    await tick(0);
    expect(calls).toBe(before);
    expect(changes).toEqual([]);
  });
});
