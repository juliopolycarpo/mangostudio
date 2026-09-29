/**
 * A stand-in for the tab's realtime socket: records which topics are
 * subscribed and lets a test deliver the signals the server would send.
 *
 * Install it with `mock.module('@/lib/realtime/realtime-client', ...)` before
 * importing the code under test, the way the other realtime suites do.
 */

import type { RealtimeInvalidateMessage } from '@mangostudio/shared/realtime';
import type {
  RealtimeClient,
  RealtimeSignal,
  RealtimeTopicListener,
} from '@/lib/realtime/realtime-client';

/**
 * Holds one listener set per topic, like the real client's ref-counted
 * subscriptions, and delivers a signal only to a topic that is subscribed.
 *
 * @example
 * const realtime = new FakeRealtimeClient();
 * await realtime.invalidate({ type: 'invalidate', topic: SETTINGS_TOPIC, scopes: ['app'] });
 */
export class FakeRealtimeClient implements RealtimeClient {
  readonly #listeners = new Map<string, Set<RealtimeTopicListener>>();

  subscribe(topic: string, listener: RealtimeTopicListener): () => void {
    const listeners = this.#listeners.get(topic) ?? new Set<RealtimeTopicListener>();
    listeners.add(listener);
    this.#listeners.set(topic, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  /** The fake has no session-bound transport to reopen. */
  reconnectForSession(): void {
    return;
  }

  /** Whether any listener is subscribed to `topic` right now. */
  isSubscribed(topic: string): boolean {
    return (this.#listeners.get(topic)?.size ?? 0) > 0;
  }

  /** Delivers a server invalidation to its topic's listeners. */
  invalidate(message: RealtimeInvalidateMessage): Promise<void> {
    return this.#deliver(message.topic, { type: 'invalidate', message });
  }

  async #deliver(topic: string, signal: RealtimeSignal): Promise<void> {
    const listeners = [...(this.#listeners.get(topic) ?? [])];
    if (listeners.length === 0) {
      throw new Error(
        `expected a subscriber on topic: ${topic} | received: none (subscribed: ${[...this.#listeners.keys()].join(', ') || 'nothing'})`
      );
    }
    await Promise.all(listeners.map((listener) => listener(signal)));
  }
}
