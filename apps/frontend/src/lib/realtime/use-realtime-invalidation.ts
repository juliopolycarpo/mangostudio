import { useEffect, useRef } from 'react';
import { authClient } from '@/lib/auth-client';
import { getRealtimeClient, type RealtimeSignal } from './realtime-client';

/**
 * Subscribes to a realtime topic for the lifetime of the component and reports
 * every signal for it.
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
 */
export function useRealtimeInvalidation(
  topic: string | null,
  onSignal: (signal: RealtimeSignal) => void | Promise<void>
): void {
  // Assigned during render so an inline arrow does not resubscribe every render;
  // the effect therefore depends on the topic alone.
  const onSignalRef = useRef(onSignal);
  onSignalRef.current = onSignal;
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (topic === null || userId === undefined) return;
    return getRealtimeClient().subscribe(topic, (signal) => onSignalRef.current(signal));
  }, [topic, userId]);
}
