// The browser side of live sync: the BroadcastChannel other tabs listen on, and the "something changed" post.
// Client only (every function is safe to call where BroadcastChannel does not exist: it does nothing).
import { CHANNEL_NAME } from './version-watcher';

/** A new channel on the shared name, or null when the browser has no BroadcastChannel. */
export function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

/**
 * Tell the other open tabs of this browser that the saved records changed. Call it after the server confirmed a
 * Booked, an Undo or an import. The message carries no data: each tab asks the server what changed.
 */
export function announceChange(): void {
  const channel = openChannel();
  if (!channel) return;
  try {
    channel.postMessage({ type: 'changed' });
  } catch {
    // Nothing to tell: the other tabs still catch up on their next poll.
  } finally {
    channel.close();
  }
}
