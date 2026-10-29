// Live sync (build-plan section 4, "Other open screens update by themselves ... within a few seconds"):
// a framework-free watcher that tells a screen when the saved records changed (import, Booked, undo).
// It polls a cheap version number, skips polls while the page is hidden, checks at once when the page becomes
// visible again, and also listens on a BroadcastChannel so another tab in the same browser hears about a
// change straight away. Everything outside it (fetch, visibility, the channel) is passed in, so it is tested
// with fakes and fake timers.

/** The slice of BroadcastChannel the watcher uses (a real BroadcastChannel fits). */
export interface WatcherChannel {
  addEventListener(type: 'message', listener: () => void): void;
  removeEventListener(type: 'message', listener: () => void): void;
}

export type Version = number | string;

export interface VersionWatcherOptions {
  /** Reads the current version. May reject (offline, server restarting): the watcher just tries again later. */
  fetchVersion: () => Promise<Version>;
  /** Called once per change, with the new version. */
  onChange: (version: Version) => void;
  /** Poll interval in ms (default 3000). */
  intervalMs?: number;
  /** The version the screen was loaded with. Without it the first successful check is the baseline. */
  initialVersion?: Version | null;
  /** True while the page is hidden (no polling then). Default: never hidden. */
  isHidden?: () => boolean;
  /** Calls the callback whenever the page's visibility changes; returns the function that stops that. */
  subscribeVisibility?: (callback: () => void) => () => void;
  /** Another tab's "something changed" messages. Closing it stays with whoever made it. */
  channel?: WatcherChannel | null;
}

export interface VersionWatcher {
  /** Stops polling and removes every listener. Safe to call twice. */
  stop(): void;
  /** Checks now, whatever the timer says (resolves when the check is done). */
  checkNow(): Promise<void>;
  /** Tells the watcher the screen already shows this version, so it does not report it as a change. */
  acknowledge(version: Version | null | undefined): void;
}

export const CHANNEL_NAME = 'kettle-stone-shortlist';
export const DEFAULT_INTERVAL_MS = 3000;

export function createVersionWatcher(options: VersionWatcherOptions): VersionWatcher {
  const { fetchVersion, onChange, intervalMs = DEFAULT_INTERVAL_MS, isHidden = () => false } = options;
  let known: Version | null = options.initialVersion ?? null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  function check(): Promise<void> {
    if (stopped) return Promise.resolve();
    // One check at a time: a slow answer is not stacked up behind more polls.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const version = await fetchVersion();
        if (stopped) return;
        if (known === null) {
          known = version;
        } else if (version !== known) {
          known = version;
          try {
            onChange(version);
          } catch {
            // A screen's own error must not stop the watcher.
          }
        }
      } catch {
        // Offline or the server is restarting: stay quiet and try again on the next poll.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const timer = setInterval(() => {
    if (!isHidden()) void check();
  }, intervalMs);

  const onMessage = () => {
    // A hidden page checks the moment it is shown again, so there is nothing to do now.
    if (!isHidden()) void check();
  };
  options.channel?.addEventListener('message', onMessage);

  const unsubscribeVisibility = options.subscribeVisibility?.(() => {
    if (!isHidden()) void check();
  });

  // Right away: sets the baseline, or catches a change made while the page was loading.
  if (!isHidden()) void check();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      options.channel?.removeEventListener('message', onMessage);
      unsubscribeVisibility?.();
    },
    checkNow: check,
    acknowledge(version) {
      if (version !== null && version !== undefined) known = version;
    },
  };
}
