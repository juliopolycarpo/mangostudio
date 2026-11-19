import { useEffect, useRef } from 'react';

import { authClient } from '@/lib/auth-client';

import {
  bindRealtimeClientToUser,
  getRealtimeClient,
  type RealtimeSignal,
} from './realtime-client';

type SignalHandler = (signal: RealtimeSignal) => void | Promise<void>;
type SignalHandlerRef = { current: SignalHandler };

type Concern = {
  readonly handlers: Set<SignalHandlerRef>;
  readonly release: () => void;
};

/**
 * One live subscription per `(topic, concern)`, shared by every component that
 * asks for it, keyed by `"<topic>\0<concern>"`.
 */
const concerns = new Map<string, Concern>();

/** NUL appears in no topic or concern name, so the two halves cannot blur. */
function concernId(topic: string, concern: string): string {
  return `${topic}\0${concern}`;
}

/** Opens the one subscription a concern owns and records it under `id`. */
function openConcern(id: string, topic: string): Concern {
  const handlers = new Set<SignalHandlerRef>();
  // The handler's promise is returned rather than swallowed, so a rejected
  // refresh stays the client's to absorb — as it was when every component
  // subscribed for itself.
  const release = getRealtimeClient().subscribe(topic, (signal) => {
    const [first] = handlers;
    return first?.current(signal);
  });
  const entry: Concern = { handlers, release };
  concerns.set(id, entry);
  return entry;
}

/**
 * Registers `handler` under its concern's subscription and returns its release.
 *
 * Signals reach the first registered handler and no other: every component
 * behind one concern asks for the same refresh, and running it once per
 * component is what turned a single reconnect into a burst of identical
 * requests.
 */
function acquire(topic: string, concern: string, handler: SignalHandlerRef): () => void {
  const id = concernId(topic, concern);
  const entry = concerns.get(id) ?? openConcern(id, topic);
  entry.handlers.add(handler);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.handlers.delete(handler);
    if (entry.handlers.size > 0) return;
    // Only drop the map slot this entry still owns: a re-subscribe that raced
    // this release has already replaced it.
    if (concerns.get(id) === entry) concerns.delete(id);
    entry.release();
  };
}

/** Drops every shared subscription. Test seam, mirroring `resetRealtimeClient`. */
export function resetRealtimeInvalidations(): void {
  concerns.clear();
}

/**
 * Subscribes to a realtime topic and reports every signal for it, once.
 *
 * `concern` names the work the callback does — "environment-entities", say —
 * and is what makes the subscription shared: however many components mount this
 * hook with the same topic and concern, one signal runs one callback. Several
 * cards on a page read the same list, and dispatching to each of them turned
 * one `subscribed` ack into one HTTP request per card (issue #941). Give two
 * genuinely different jobs on one topic two different concern names, or one of
 * them will never run.
 *
 * Callers invalidate with their own `queryClient`, so this hook needs no
 * knowledge of query keys. Treat a `subscribed` signal as "anything cached for
 * this topic may be stale" — events published while the socket was down are lost
 * by design, so the ack is the barrier to refresh behind.
 *
 * The socket is an optimization. Keep existing mutation invalidations and
 * refetch-on-reconnect exactly as they are: a permanently failing socket must
 * leave the feature working.
 *
 * Pass `null` while the topic is unknown (no chat selected yet, for instance).
 *
 * @example
 * useRealtimeInvalidation(ACTIVITY_TOPIC, 'activity-feed', () =>
 *   queryClient.invalidateQueries({ queryKey: activityKeys.all })
 * );
 */
export function useRealtimeInvalidation(
  topic: string | null,
  concern: string,
  onSignal: SignalHandler
): void {
  useRealtimeInvalidations(topic === null ? NO_TOPICS : [topic], concern, (_topic, signal) =>
    onSignal(signal)
  );
}

type TopicSignalHandler = (topic: string, signal: RealtimeSignal) => void | Promise<void>;

const NO_TOPICS: readonly string[] = [];

/**
 * {@link useRealtimeInvalidation} for a set of topics that changes while the
 * component stays mounted, such as one topic per repository whose rows are on
 * screen.
 *
 * Each topic is its own ref-counted subscription under the same concern, and the
 * handler is told which topic fired. When the set changes, only topics that
 * entered it cost a `subscribe` frame and an ack: a topic that stays is released
 * and re-acquired within the same commit, inside the client's linger window, so
 * the socket never hears of it. A topic that left is unsubscribed after the
 * linger. The caller bounds the set; the server caps a socket at 64 topics.
 *
 * @example
 * useRealtimeInvalidations(repoTopics, 'git-repo-sidebar', (topic, signal) => refresh(topic));
 */
export function useRealtimeInvalidations(
  topics: readonly string[],
  concern: string,
  onSignal: TopicSignalHandler
): void {
  // Same reasoning as the single-topic hook: assigned during render so an inline
  // arrow does not resubscribe, with the effect keyed on the topic set alone.
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;
  // A topic never contains a newline, so the joined string is a faithful key that
  // keeps a new array with the same members from resubscribing.
  const topicsKey = topics.join('\n');

  useEffect(() => {
    if (topicsKey === '' || userId === undefined) return;
    bindRealtimeClientToUser(userId);
    const releases = topicsKey.split('\n').map((topic) =>
      acquire(topic, concern, {
        current: (signal) => onSignalRef.current(topic, signal),
      })
    );
    return () => {
      for (const release of releases) release();
    };
  }, [topicsKey, concern, userId]);
}
